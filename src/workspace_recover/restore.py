"""Single resolved recovery engine shared by restore and backup rehearsal."""
from pathlib import Path
import os
import re
from command_execution.documents import stringify
from .formats import schema, assert_format, assert_requirements, assert_transport
from .selection import assert_inventory
from .archive import assemble_parts
from .archive_profile import validate_archive_profile, fetch_bootstrap, unpack_archive
from .workflow import execute_workflow, validate_workflow
from .providers_factory import handoff_provider, provider_from_config, provider_context, resource_provider
from .template import record_input_batch
from .batch import all_settled
from .util import read_json, write_json, sha256_file, sha256_text, now_iso, integer


def expected_folder(value):
    if not value: return None
    match = re.search(r"/folders/([A-Za-z0-9_-]+)", str(value))
    return match.group(1) if match else str(value)


def provider_ready_or_wait(store, session, provider, profile="default"):
    try:
        provider.ready()
        return True
    except Exception as error:
        if getattr(error, "code", None) != "AUTH_REQUIRED": raise
        session.update(state="waiting_for_auth", next={"type": "manual", "action": "google-auth", "command": getattr(error, "auth_command", f"workspace-recover auth google-workspace --profile {profile} --client <oauth-client.json>"), "reason": str(error)})
        store.save(session)
        return False


def execute_recovery_manifest(recovery, target, session_dir, provider, expected_drive_folder=None, operation="restore", fresh_download=False):
    assert_format(recovery, "recovery-manifest")
    assert_requirements(recovery.get("requires"))
    transport = assert_transport(recovery["transport"])
    if provider is None: raise ValueError("resolved recovery execution requires a provider")
    validate_workflow(recovery.get("restore", {}).get("workflow", []))
    def safe_name(name): return isinstance(name, str) and name not in ("", ".", "..") and not re.search(r"[\\/\0]", name) and not re.match(r"^[A-Za-z]:", name)
    if not safe_name(transport["archive"].get("fileName")): raise ValueError("unsafe archive filename in recovery manifest")
    seen = set()
    for index, part in enumerate(transport["parts"]):
        if not safe_name(part.get("fileName")) or part["fileName"] in seen: raise ValueError("unsafe or duplicate part filename")
        if part.get("index") != index: raise ValueError("transport part indices must be contiguous and ordered")
        seen.add(part["fileName"])
    profile = recovery.get("archiveProfile")
    validate_archive_profile(profile, True)
    features = recovery.get("requires", {}).get("features", [])
    if profile:
        if profile["format"] != transport["archive"]["format"]: raise ValueError("archive profile/transport format mismatch")
    elif transport["archive"]["format"] != "tar.gz" or "archive-profiles" in features: raise ValueError("archive profile is required for declared format")
    selection = recovery.get("selection")
    if "selection-inventory" in features and not selection: raise ValueError("recovery requires selection inventory")
    if selection and (not integer(selection.get("bytes")) or selection["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", selection.get("sha256", "")) or not isinstance(selection.get("remote", {}).get("id"), str)): raise ValueError("invalid selection inventory reference")
    provider_config = transport.get("provider", {})
    folder = expected_folder(expected_drive_folder or provider_config.get("folderId"))
    if expected_drive_folder and provider_config.get("folderId") and expected_folder(provider_config["folderId"]) != expected_folder(expected_drive_folder): raise ValueError("provided Drive folder does not match recovery manifest folder")
    directory, workspace = Path(session_dir), Path(os.path.abspath(target))
    directory.mkdir(parents=True, exist_ok=True)
    execution_file, result_file = directory / "recovery-execution.json", directory / "recovery-result.json"
    identity = sha256_text(stringify({"recovery": recovery, "target": str(workspace), "operation": operation}))
    checkpoint = assert_format(read_json(execution_file), "recovery-execution") if execution_file.exists() else {"schema": schema("recovery-execution"), "identity": identity, "phase": "downloads"}
    if checkpoint["identity"] != identity: raise ValueError("recovery execution differs from frozen manifest/target")
    if checkpoint["phase"] == "completed": return read_json(result_file)
    if checkpoint["phase"] in ("extracting", "workflow-running"): raise ValueError("Interrupted side-effectful recovery stage; inspect preserved files before a new run, no implicit replay")
    write_json(execution_file, checkpoint)
    downloads = directory / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    def download(part):
        file = downloads / part["fileName"]
        reusable = not fresh_download and file.exists() and file.stat().st_size == part["bytes"] and sha256_file(file) == part["sha256"]
        if not reusable:
            file.unlink(missing_ok=True)
            provider.download(part["remote"], file, expected_folder_id=folder, expected_bytes=part["bytes"], expected_sha256=part["sha256"])
        if file.stat().st_size != part["bytes"]: raise ValueError(f"download size mismatch: {part['fileName']}")
        if sha256_file(file) != part["sha256"]: raise ValueError(f"download hash mismatch: {part['fileName']}")
        return {**part, "path": str(file)}
    parts = all_settled([lambda part=part: download(part) for part in transport["parts"]])
    archive = downloads / transport["archive"]["fileName"]
    assembled = assemble_parts(parts, archive)
    if assembled["sha256"] != transport["archive"]["sha256"] or assembled["bytes"] != transport["archive"]["bytes"]: raise ValueError("assembled recovery archive mismatch")
    inventory = None
    if selection:
        file = downloads / "selection-manifest.json"
        reusable = not fresh_download and file.exists() and file.stat().st_size == selection["bytes"] and sha256_file(file) == selection["sha256"]
        if not reusable: provider.download(selection["remote"], file, expected_folder_id=folder, expected_bytes=selection["bytes"], expected_sha256=selection["sha256"])
        if file.stat().st_size != selection["bytes"] or sha256_file(file) != selection["sha256"]: raise ValueError("selection inventory download mismatch")
        inventory = assert_inventory(read_json(file))
    bootstrap = fetch_bootstrap(profile, provider, directory, folder, fresh_download)
    if checkpoint["phase"] != "extracted":
        checkpoint["phase"] = "extracting"
        write_json(execution_file, checkpoint)
        checkpoint["unpackReport"] = unpack_archive(profile, archive, workspace, recovery["restore"].get("existingTarget") != "merge", inventory, directory, bootstrap)
        checkpoint["phase"] = "extracted"
        write_json(execution_file, checkpoint)
    checkpoint["phase"] = "workflow-running"
    write_json(execution_file, checkpoint)
    workflow = execute_workflow(recovery["restore"].get("workflow", []), workspace, directory / "workflow", {"operation": operation})
    result = {"workspace": str(workspace), "archive": str(archive), "assembled": assembled, "workflow": workflow, "unpackReport": checkpoint.get("unpackReport"), "inventoryVerified": inventory is not None, "inventoryEntries": len(inventory["entries"]) if inventory else 0}
    write_json(result_file, result)
    checkpoint["phase"] = "completed"
    write_json(execution_file, checkpoint)
    return result


def resolve_restore(store, session):
    if session["state"] in ("completed", "completed_with_warnings", "failed"): return session
    if session.get("planFrozen"): return run_restore_plan(store, session, assert_format(read_json(session["planPath"]), "plan"))
    directory = store.directory(session["id"])
    if not session.get("recoveryManifestPath"):
        provider = handoff_provider(session["handoffReference"], session["googleProfile"], **provider_context(store, session, "handoff-source", ["gmail.read"], session.get("execution")))
        if not provider_ready_or_wait(store, session, provider, session["googleProfile"]): return session
        handoff = provider.read_handoff(session["handoffReference"], directory / "handoff")
        attachments = handoff["attachments"]
        index_file, recovery_file, transport_file = [attachments.get(name) for name in ("workspace-handoff.json", "workspace-recovery-manifest.json", "workspace-transport-manifest.json")]
        if not index_file or not recovery_file or not transport_file: raise ValueError("handoff is missing required recovery attachments")
        index = assert_format(read_json(index_file), "handoff")
        if sha256_file(recovery_file) != index["recoveryManifestSha256"]: raise ValueError("recovery manifest hash mismatch in handoff")
        transport = assert_format(read_json(transport_file), "transport-manifest")
        if sha256_file(transport_file) != index["transportManifestSha256"]: raise ValueError("transport manifest hash mismatch in handoff")
        recovery = assert_format(read_json(recovery_file), "recovery-manifest")
        if stringify(recovery["transport"]) != stringify(transport): raise ValueError("handoff transport does not match embedded recovery transport")
        session.update(recoveryManifestPath=recovery_file, handoffIndexPath=index_file, handoffId=handoff["id"])
        store.save(session)
    recovery = assert_format(read_json(session["recoveryManifestPath"]), "recovery-manifest")
    assert_requirements(recovery.get("requires"))
    assert_transport(recovery["transport"])
    validate_workflow(recovery.get("restore", {}).get("workflow", []))
    target = session.get("inputs", {}).get("target")
    target_source = "operator-input"
    if target is None:
        target = recovery.get("restore", {}).get("target", {}).get("path")
        target_source = "recovery-manifest"
    if target is None:
        profile = session.get("localProfile")
        name = recovery.get("project", {}).get("name")
        if profile and profile.get("workspaceRoot") and name:
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name): raise ValueError("unsafe project name for inferred target")
            target = str(Path(profile["workspaceRoot"]) / name)
        target_source = "local-profile"
    if not isinstance(target, str) or not target or "\0" in target:
        return record_input_batch(store, session, {"schema": schema("template"), "name": "restore-inputs", "inputs": {"target": {"type": "path", "required": True, "description": "New destination directory"}}, "manifest": {}},
            {"missing": [] if target else ["target"], "errors": [{"key": "target", "message": "target must be a path string"}] if target else [], "values": {"target": target or None}, "provenance": {}})
    selected = str(Path(os.path.abspath(target)))
    plan = {"schema": schema("plan"), "operation": "restore", "createdAt": now_iso(), "handoffId": session.get("handoffId"), "recoveryManifestSha256": sha256_file(session["recoveryManifestPath"]), "target": selected,
            "bindings": {"target": {"value": selected, "source": target_source}}, "googleProfile": session["googleProfile"], "expectedDriveFolder": session.get("expectedDriveFolder"), "recoveryManifest": recovery}
    session["planPath"] = store.write(session["id"], "plan.json", plan)
    session["planFrozen"] = True
    store.save(session)
    return run_restore_plan(store, session, plan)


def run_restore_plan(store, session, plan):
    session.update(state="running", next=None)
    store.save(session)
    directory, recovery = store.directory(session["id"]), plan["recoveryManifest"]
    config = recovery["transport"]["provider"]
    overrides = {"profile": plan.get("googleProfile") or session["googleProfile"]} if config["type"] == "google-workspace" else {"readOnly": True}
    provider = provider_from_config(resource_provider(config), {**overrides, **provider_context(store, session, "restore-artifacts", ["drive.download"], session.get("execution"))})
    if not provider_ready_or_wait(store, session, provider, session["googleProfile"]): return session
    result = execute_recovery_manifest(recovery, plan["target"], directory, provider, plan.get("expectedDriveFolder") or session.get("expectedDriveFolder"))
    workflow = result["workflow"]
    if result.get("unpackReport"): store.set_info(session, "unpack", short=result["unpackReport"]["short"], medium=result["unpackReport"]["medium"], full_path=result["unpackReport"]["fullPath"])
    receipt = {"schema": schema("restore-receipt"), "sessionId": session["id"], "target": result["workspace"], "archiveVerified": True, "restoreStatus": "success", "workflowHardFailure": workflow["hardFailure"], "verificationStatus": "warnings" if workflow["advisoryWarnings"] else "passed", "completedAt": now_iso()}
    full = store.write(session["id"], "restore-receipt.json", receipt)
    short = "restore success: " + result["workspace"]
    store.set_info(session, "restore", short=short, medium=short + f"\narchiveSha256: {result['assembled']['sha256']}\nworkflow: {'failed' if workflow['hardFailure'] else 'completed'}\nverification: {receipt['verificationStatus']}", full_path=full)
    for kind in ("verification", "workflow"):
        report = workflow[kind + "Report"]
        store.set_info(session, kind, short=report["short"], medium=report["medium"], full_path=report["fullPath"])
    for item in workflow["results"]:
        if item.get("report"):
            report = item["report"]
            store.set_info(session, "step:" + item["id"], short=report["short"], medium=report["medium"], full_path=report["fullPath"])
    session.update(state="failed" if workflow["hardFailure"] else "completed_with_warnings" if workflow["advisoryWarnings"] else "completed", next={"type": "none"}, result={"restore": "success", "workflow": "failed" if workflow["hardFailure"] else "completed", "verification": receipt["verificationStatus"]})
    return store.save(session)

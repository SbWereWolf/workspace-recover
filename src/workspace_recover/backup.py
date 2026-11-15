"""Frozen backup capture, fresh legacy rehearsal and verified handoff."""
from pathlib import Path
import os
import re
from .archive import split_file
from .archive_profile import prepare_bootstrap, pack_archive, resolved_profile
from .batch import all_settled
from .clean_room import create_clean_room, remove_clean_room
from .declaration import compile_manifest
from .formats import schema, assert_format
from .providers_factory import provider_from_config, provider_context, resource_provider
from .restore import execute_recovery_manifest, provider_ready_or_wait
from .selection import select_source, selection_nul, validate_selection
from .session import terminal_state
from .template import render_template, record_input_batch
from .util import read_json, sha256_file, now_iso
from .workflow import validate_workflow


def freeze_plan(store, session, manifest):
    manifest = compile_manifest(manifest)
    assert_format(manifest, "manifest")
    for value, name in ((manifest.get("backup", {}).get("source", {}).get("path"), "backup.source.path"), (manifest.get("backup", {}).get("provider", {}).get("type"), "backup.provider.type"), (manifest.get("handoff", {}).get("provider", {}).get("type"), "handoff.provider.type"), (manifest.get("restore"), "restore")):
        if value is None or value == "": raise ValueError(f"manifest.{name} is required")
    source = manifest["backup"]["source"]
    validate_selection(source.get("include", ["**"]), source.get("exclude", []))
    validate_workflow(manifest["restore"].get("workflow", []))
    file = store.write(session["id"], "manifest.json", manifest)
    plan = {"schema": schema("plan"), "operation": "backup", "createdAt": now_iso(), "manifestSha256": sha256_file(file), "manifest": manifest, "inputProvenance": session.get("inputProvenance", {})}
    session.update(planPath=store.write(session["id"], "plan.json", plan), manifestPath=file, planFrozen=True)
    store.save(session)
    return plan


def resolve_backup(store, session, template, values):
    rendered = render_template(template, values, session.get("inputProvenance", {}))
    session.update(inputs=rendered["values"], inputProvenance=rendered["provenance"])
    if rendered["missing"] or rendered["errors"]: return record_input_batch(store, session, template, rendered)
    return run_backup_plan(store, session, freeze_plan(store, session, rendered["manifest"]))


def start_backup(store, template_path, values, provenance, execution):
    session = store.create("backup", execution=execution, templateSource=str(Path(template_path).absolute()), inputs=values, inputProvenance=provenance)
    def start():
        template = assert_format(read_json(template_path), "template")
        store.write(session["id"], "template.json", template)
        store.write(session["id"], "values.json", {"schema": schema("values"), "values": values})
        return resolve_backup(store, session, template, values)
    return store.attempt(session, start)


def start_manifest(store, manifest_path, execution):
    session = store.create("backup", execution=execution, manifestSource=str(Path(manifest_path).absolute()), inputs={})
    return store.attempt(session, lambda: run_backup_plan(store, session, freeze_plan(store, session, read_json(manifest_path))))


def report_info(store, session, kind, report):
    store.set_info(session, kind, short=report["short"], medium=report["medium"], full_path=report["fullPath"])


def remote_reference(value): return {key: value[key] for key in ("id", "url", "parent") if key in value}


def run_backup_plan(store, session, plan):
    if terminal_state(session["state"]): return session
    session.update(state="running", next=None)
    progress = session.setdefault("progress", {})
    store.save(session)
    manifest, directory = plan["manifest"], store.directory(session["id"])
    config = manifest["backup"]["provider"]
    provider = provider_from_config(config, provider_context(store, session, "artifacts", ["drive.upload", "drive.download"], session.get("execution")))
    mail = provider_from_config(manifest["handoff"]["provider"], provider_context(store, session, "handoff", ["gmail.send", "gmail.read"], session.get("execution")))
    if not provider_ready_or_wait(store, session, provider) or not provider_ready_or_wait(store, session, mail): return session
    artifacts = directory / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    profile = manifest.get("archiveProfile")
    archive = artifacts / ("workspace-backup." + (profile or {}).get("format", "tar.gz"))
    if "bootstrap" not in progress:
        progress["bootstrap"] = prepare_bootstrap(profile, directory)
        store.save(session)
    if "archive" not in progress:
        source = manifest["backup"]["source"]
        selection = select_source(source["path"], source.get("include", ["**"]), source.get("exclude", []))
        selection_file = directory / "selected-files.nul"
        with os.fdopen(os.open(selection_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream: stream.write(selection_nul(selection))
        captured = pack_archive(profile, source["path"], archive, selection, selection_file, directory, progress["bootstrap"])
        if captured.get("packReport"): report_info(store, session, "pack", captured.pop("packReport"))
        inventory = captured.pop("inventory")
        file = store.write(session["id"], "selection-manifest.json", inventory)
        progress["inventory"] = {"path": file, "bytes": Path(file).stat().st_size, "sha256": sha256_file(file)}
        totals = inventory["totals"]
        short = f"{totals['files']} file(s), {totals['entries']} entries, {totals['bytes']} bytes"
        from command_execution.documents import stringify
        store.set_info(session, "selection", short=short, medium=f"files={totals['files']}; entries={totals['entries']}; bytes={totals['bytes']}\ninclude={stringify(selection['patterns']['include'])}\nexclude={stringify(selection['patterns']['exclude'])}\nvisited={totals['visited']}; excludedRoots={totals['excludedRoots']}\nInventory: {file}", full_path=file)
        progress["archive"] = captured
        store.save(session)
    elif not archive.exists() or sha256_file(archive) != progress["archive"]["sha256"]: raise ValueError("captured archive changed or disappeared; do not recapture a frozen backup")
    if "parts" not in progress:
        progress["parts"] = split_file(archive, artifacts / "parts", manifest["backup"].get("transport", {}).get("partSizeBytes") or 64 * 1024 * 1024)
        store.save(session)
    progress.setdefault("uploadedParts", [None] * len(progress["parts"]))
    folder = config.get("folderId")
    def upload_bootstrap(item):
        if item.get("remote"): return
        remote = provider.upload(item["path"], name=f"workspace-recover-{session['id']}-bootstrap-{item['id']}", folder_id=folder)
        with store._lock:
            item["remote"] = remote
            store.save(session)
    def upload_part(part):
        if progress["uploadedParts"][part["index"]]: return
        remote = provider.upload(part["path"], name=f"{session['id']}-{part['fileName']}", folder_id=folder)
        with store._lock:
            progress["uploadedParts"][part["index"]] = {**remote, **{key: part[key] for key in ("index", "bytes", "sha256", "fileName")}}
            store.save(session)
    def upload_selection():
        if progress.get("selectionRemote"): return
        remote = provider.upload(progress["inventory"]["path"], name=f"workspace-recover-{session['id']}-selection.json", folder_id=folder)
        with store._lock:
            progress["selectionRemote"] = remote
            store.save(session)
    all_settled([*[lambda item=item: upload_bootstrap(item) for item in progress["bootstrap"]], *[lambda part=part: upload_part(part) for part in progress["parts"]], upload_selection])
    transport = {"schema": schema("transport-manifest"), "archive": {"fileName": archive.name, "bytes": progress["archive"]["bytes"], "sha256": progress["archive"]["sha256"], "format": (profile or {}).get("format", "tar.gz")}, "provider": resource_provider(config), "parts": [{**{key: part[key] for key in ("index", "fileName", "bytes", "sha256")}, "remote": remote_reference(part)} for part in progress["uploadedParts"]]}
    transport_file = store.write(session["id"], "transport-manifest.json", transport)
    def upload_verified(key, file, suffix, digest):
        if not progress.get(key + "Remote"):
            progress[key + "Remote"] = provider.upload(file, name=f"workspace-recover-{session['id']}-{suffix}.json", folder_id=folder)
            store.save(session)
        if not progress.get(key + "Readback"):
            out = directory / (key + "-readback.json")
            provider.download(progress[key + "Remote"], out, expected_folder_id=folder, expected_bytes=Path(file).stat().st_size, expected_sha256=digest)
            if sha256_file(out) != digest: raise ValueError(key + " manifest provider roundtrip mismatch")
            progress[key + "Readback"] = True
            store.save(session)
    upload_verified("transport", transport_file, "transport-manifest", sha256_file(transport_file))
    recovery_file = directory / "workspace-recovery-manifest.json"
    if progress.get("recoveryManifestSha256"):
        if sha256_file(recovery_file) != progress["recoveryManifestSha256"]: raise ValueError("frozen recovery manifest changed")
        recovery = read_json(recovery_file)
    else:
        recovery = {**({"archiveProfile": resolved_profile(profile, progress["bootstrap"])} if profile else {}), "schema": schema("recovery-manifest"), "backupSessionId": session["id"], "createdAt": now_iso(), "transport": transport, "selection": {"bytes": progress["inventory"]["bytes"], "sha256": progress["inventory"]["sha256"], "remote": remote_reference(progress["selectionRemote"])}, "requires": {"formatVersion": 3, "features": list(dict.fromkeys([*manifest.get("requires", {}).get("features", []), "pax-paths", "selection-inventory", "archive-profiles" if profile else "safe-merge"]))}, "project": {"name": manifest.get("name") or "workspace"}, "restore": {"existingTarget": manifest["restore"].get("existingTarget") or "reject", "target": manifest["restore"].get("target") or {"required": True}, "workflow": manifest["restore"].get("workflow", [])}}
        store.write(session["id"], recovery_file.name, recovery)
        progress["recoveryManifestSha256"] = sha256_file(recovery_file)
        store.save(session)
    rehearsal_file, rehearsal_result = directory / "rehearsal-receipt.json", directory / "rehearsal-result.json"
    if progress.get("rehearsalCompleted"):
        execution, receipt = read_json(rehearsal_result), read_json(rehearsal_file)
    else:
        if not progress.get("rehearsal"):
            root = create_clean_room(session["id"])
            progress["rehearsal"] = {"cleanRoom": root, "workspace": str(Path(root) / "workspace"), "state": "running"}
            store.save(session)
        root = progress["rehearsal"]["cleanRoom"]
        try: execution = execute_recovery_manifest(recovery, progress["rehearsal"]["workspace"], directory / "rehearsal", provider, folder, "rehearsal", True)
        except Exception as error:
            if getattr(error, "code", None) in ("EXTERNAL_PENDING", "CAPABILITY_REQUIRED", "EXTERNAL_OUTCOME_UNKNOWN"): raise
            progress["rehearsal"]["state"] = "failed"
            store.write(session["id"], rehearsal_file.name, {"schema": schema("rehearsal-receipt"), "sessionId": session["id"], "cleanRoom": root, "cleanRoomPreserved": Path(root).exists(), "restoreStatus": "failed", "verificationStatus": "not_run", "error": str(error), "completedAt": now_iso()})
            raise
        workflow = execution["workflow"]
        clean = not workflow["hardFailure"] and not workflow["advisoryWarnings"]
        receipt = {"schema": schema("rehearsal-receipt"), "sessionId": session["id"], "cleanRoom": root, "restoreStatus": "success", "verificationStatus": "warnings" if workflow["advisoryWarnings"] else "passed", "workflowHardFailure": workflow["hardFailure"], "cleanRoomPreserved": not clean, "completedAt": now_iso()}
        store.write(session["id"], rehearsal_result.name, execution)
        if clean:
            remove_clean_room(root)
            receipt["cleanRoom"] = None
        store.write(session["id"], rehearsal_file.name, receipt)
        progress["rehearsal"].update(state="completed" if clean else "completed_with_warnings", cleanRoom=receipt["cleanRoom"])
        progress["rehearsalCompleted"] = True
        store.save(session)
    workflow = execution["workflow"]
    if execution.get("unpackReport"): report_info(store, session, "unpack", execution["unpackReport"])
    backup_file = directory / "backup-receipt.json"
    if not progress.get("backupReceiptWritten"):
        store.write(session["id"], backup_file.name, {"schema": schema("backup-receipt"), "sessionId": session["id"], "archive": transport["archive"], "transportManifestRemote": progress["transportRemote"], "freshProviderRoundtripVerified": True, "recoveryRehearsal": receipt, "completedAt": now_iso()})
        progress["backupReceiptWritten"] = True
        store.save(session)
    backup_receipt = read_json(backup_file)
    upload_verified("recovery", recovery_file, "recovery-manifest", progress["recoveryManifestSha256"])
    index = {"schema": schema("handoff"), "backupSessionId": session["id"], "recoveryManifestSha256": progress["recoveryManifestSha256"], "transportManifestSha256": sha256_file(transport_file), "backupReceiptSha256": sha256_file(backup_file), "rehearsalReceiptSha256": sha256_file(rehearsal_file)}
    index_file = store.write(session["id"], "workspace-handoff.json", index)
    attachments = [{"name": name, "path": str(file), "mimeType": "application/json"} for name, file in (("workspace-handoff.json", index_file), ("workspace-recovery-manifest.json", recovery_file), ("workspace-transport-manifest.json", transport_file), ("workspace-backup-receipt.json", backup_file), ("workspace-rehearsal-receipt.json", rehearsal_file))]
    context = {"sessionId": session["id"], "projectName": manifest.get("name") or "workspace", "archiveSha256": transport["archive"]["sha256"], "archiveBytes": str(transport["archive"]["bytes"]), "archiveLinks": "\n".join(part["remote"].get("url") or part["remote"]["id"] for part in transport["parts"]), "recoveryManifestUrl": progress["recoveryRemote"].get("url") or progress["recoveryRemote"]["id"], "rehearsal": "failed" if workflow["hardFailure"] else "success", "verification": "warnings" if workflow["advisoryWarnings"] else "passed"}
    default_body = "workspace-recover backup session: {{sessionId}}\nProject: {{projectName}}\nRecovery rehearsal: {{rehearsal}}\nVerification: {{verification}}\nArchive bytes: {{archiveBytes}}\nArchive SHA256: {{archiveSha256}}\n\n{{archiveLinks}}\nRecovery manifest: {{recoveryManifestUrl}}\n\nMore: workspace-recover info {{sessionId}}"
    def substitute(match):
        if match[1] not in context: raise ValueError("unknown mail template placeholder: " + match[1])
        return context[match[1]]
    body = re.sub(r"\{\{([A-Za-z][A-Za-z0-9]*)\}\}", substitute, manifest["handoff"].get("bodyTemplate") or default_body)
    subject = manifest["handoff"].get("subject") or "workspace-recover handoff " + session["id"]
    if not progress.get("handoff"):
        progress["handoff"] = mail.send_handoff(session["id"], manifest["handoff"].get("to"), subject, body, attachments)
        store.save(session)
    handoff = progress["handoff"]
    hashes = {item["name"]: sha256_file(item["path"]) for item in attachments}
    readback = mail.read_handoff(handoff.get("url") or handoff["id"], directory / "handoff-readback")
    for name, digest in hashes.items():
        if name not in readback["attachments"] or sha256_file(readback["attachments"][name]) != digest: raise ValueError("handoff readback attachment mismatch: " + name)
    if "subject" in readback and readback["subject"] != subject: raise ValueError("Gmail readback subject mismatch")
    def recipients(value): return sorted(x.strip().lower() for x in (value if isinstance(value, list) else str(value).split(",")))
    if "to" in readback and recipients(readback["to"]) != recipients(manifest["handoff"].get("to", [])): raise ValueError("Gmail readback recipients mismatch")
    if isinstance(readback.get("body"), str) and readback["body"].replace("\r\n", "\n").rstrip() != body.rstrip(): raise ValueError("handoff body readback mismatch")
    handoff_report = store.write(session["id"], "reports/handoff/primary.json", {"id": readback["id"], "url": handoff.get("url"), "readbackVerified": True, "attachments": readback["attachments"], "attachmentHashes": hashes})
    backup_report = store.write(session["id"], "reports/backup/primary.json", {"backupReceipt": backup_receipt, "handoff": handoff, "readbackVerified": True})
    short = f"{len(transport['parts'])} part(s), {transport['archive']['bytes']} bytes, provider roundtrip verified"
    store.set_info(session, "backup", short=short, medium=f"{short}\narchiveSha256: {transport['archive']['sha256']}\nhandoff: {handoff.get('url') or handoff['id']}\nrehearsal: {receipt['restoreStatus']}\nverification: {receipt['verificationStatus']}", full_path=backup_report)
    for name in ("verification", "workflow"): report_info(store, session, name, workflow[name + "Report"])
    for item in workflow["results"]:
        if item.get("report"): report_info(store, session, "step:" + item["id"], item["report"])
    store.set_info(session, "handoff", short="handoff sent/read back: " + handoff["id"], medium=f"{handoff.get('url') or handoff['id']}\nattachments={len(attachments)}", full_path=handoff_report)
    session.update(handoff=handoff, state="failed" if workflow["hardFailure"] else "completed_with_warnings" if workflow["advisoryWarnings"] else "completed", next={"type": "none"}, result={"backup": "created", "recoveryRehearsal": context["rehearsal"], "verification": context["verification"]})
    return store.save(session)

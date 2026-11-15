"""Public operation dispatch; resumed plans use frozen session inputs."""
from pathlib import Path
import shutil
from .template import resolve_template, supplied
from .formats import assert_format, schema
from .profiles import load_profile
from .project import discover_project, project_values, start_init, resolve_init
from .backup import start_backup, start_manifest, resolve_backup, run_backup_plan
from .restore import resolve_restore
from .session import terminal_state
from .util import read_json, deep_merge, sha256_file


def start_operation(command, references, options, store):
    execution = {**({"executor": options["executor"]} if options.get("executor") else {}), **({"bridge": str(Path(options["bridge"]).absolute())} if options.get("bridge") else {})}
    values, provenance = supplied(options)
    if command == "init":
        return start_init(store, resolve_template(references[0] if references else "local"), options.get("project-dir") or Path.cwd(), values, provenance)
    if command == "backup":
        reference = references[0] if references else options.get("template")
        if not reference:
            project = discover_project()
            if not project: raise ValueError("Project configuration not found. Run workspace-recover init, or supply a template.")
            values, provenance = project_values(project, options)
            session = start_backup(store, project["directory"] / project["document"]["template"], values, provenance, execution)
            return session
        file = Path(reference).absolute()
        if file.exists() and read_json(file).get("schema") == schema("manifest"):
            if any(options.get(key) for key in ("values", "set", "set-json")): raise ValueError("--values/--set are for templates; a rendered manifest is already complete")
            return start_manifest(store, file, execution)
        return start_backup(store, resolve_template(reference), values, provenance, execution)
    if len(references) > 1: raise ValueError("restore accepts one positional source")
    if len(references) + bool(options.get("handoff")) + bool(options.get("manifest")) != 1: raise ValueError("restore requires exactly one positional source, --handoff or --manifest")
    manifest, handoff = options.get("manifest"), options.get("handoff")
    if references:
        reference = references[0]
        if not reference.startswith(("http:", "https:", "file:")) and Path(reference).is_file() and str(read_json(reference).get("schema", "")).startswith("workspace-recover/recovery-manifest/"): manifest = reference
        else: handoff = reference
    if set(values) - {"target"}: raise ValueError("unknown restore input(s): " + ", ".join(sorted(set(values) - {"target"})))
    profile = load_profile(options.get("profile", "default"), optional=not options.get("profile"))
    session = store.create("restore", execution=execution, inputs={"target": options.get("target", values.get("target"))}, inputProvenance=provenance, googleProfile=options.get("google-profile") or (profile or {}).get("googleProfile") or "default", localProfile=profile, expectedDriveFolder=options.get("drive-folder"), **({"handoffReference": handoff} if handoff else {}))
    def start():
        if manifest:
            source = Path(manifest).absolute()
            assert_format(read_json(source), "recovery-manifest")
            target = store.directory(session["id"]) / "selected-recovery-manifest.json"
            shutil.copyfile(source, target)
            session.update(recoveryManifestPath=str(target), manifestSource=str(source), recoveryManifestSha256=sha256_file(target))
            store.save(session)
        return resolve_restore(store, session)
    return store.attempt(session, start)


def continue_operation(store, session, values, provenance):
    if terminal_state(session["state"]): return session
    def resume():
        if session.get("planFrozen"):
            if values: raise ValueError("frozen plan cannot be overwritten; start a new session")
            if session["operation"] == "backup": return run_backup_plan(store, session, assert_format(read_json(session["planPath"]), "plan"))
            return resolve_restore(store, session)
        if session["operation"] == "restore":
            if set(values) - {"target"}: raise ValueError("unknown restore input(s): " + ", ".join(sorted(set(values) - {"target"})))
            session["inputs"] = deep_merge(session.get("inputs", {}), values)
            store.save(session)
            return resolve_restore(store, session)
        directory = store.directory(session["id"])
        template = assert_format(read_json(directory / "template.json"), "template")
        prior = assert_format(read_json(directory / "values.json"), "values")["values"]
        merged = deep_merge(prior, values)
        for key, entries in provenance.items(): session.setdefault("inputProvenance", {}).setdefault(key, []).extend(entries)
        store.write(session["id"], "values.json", {"schema": schema("values"), "values": merged})
        return (resolve_init if session["operation"] == "init" else resolve_backup)(store, session, template, merged)
    return store.attempt(session, resume)

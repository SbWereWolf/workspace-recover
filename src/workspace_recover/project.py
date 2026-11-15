"""Portable caller-owned project configuration and initialization."""
from pathlib import Path
from .formats import assert_format, schema
from .template import render_template, record_input_batch, load_values
from .session import terminal_state
from .util import read_json, write_json, write_text, deep_merge


def discover_project(start=None):
    directory = Path(start or Path.cwd()).absolute()
    while True:
        file = directory / ".workspace-recover" / "project.json"
        if file.exists():
            document = assert_format(read_json(file), "project")
            if not isinstance(document.get("template"), str) or not isinstance(document.get("values"), list) or any(not isinstance(x, str) for x in document["values"]): raise ValueError("invalid project configuration")
            return {"root": str(directory), "directory": file.parent, "file": file, "document": document}
        if directory.parent == directory: return None
        directory = directory.parent


def project_values(project, options):
    files = [str(project["directory"] / name) for name in project["document"]["values"]]
    supplied, provenance = load_values([*files, *options.get("values", [])], options.get("set", []), options.get("set-json", []))
    values = deep_merge(project["document"].get("defaults", {}), supplied)
    if values.get("sourcePath") is None: values["sourcePath"] = project["root"]
    if supplied.get("sourcePath") is None: provenance["sourcePath"] = [{"source": "project-root", "value": project["root"]}]
    return values, provenance


def resolve_init(store, session, template, values):
    rendered = render_template(template, values, session.get("inputProvenance", {}))
    if rendered["missing"] or rendered["errors"]: return record_input_batch(store, session, template, rendered)
    root = Path(session["projectRoot"])
    directory = root / ".workspace-recover"
    directory.mkdir()
    write_json(directory / "template.json", template, 0o644)
    local = dict(rendered["values"])
    defaults = {"projectName": local.pop("projectName", None)}
    if Path(local["sourcePath"]).absolute() == root: local.pop("sourcePath")
    write_json(directory / "values.local.json", {"schema": schema("values"), "values": local})
    write_json(directory / "values.example.json", {"schema": schema("values"), "values": {}}, 0o644)
    write_text(directory / ".gitignore", "values.local.json\n", 0o644)
    config = {"schema": schema("project"), "template": "template.json", "values": ["values.local.json"], "defaults": defaults}
    write_json(directory / "project.json", config, 0o644)
    full = store.write(session["id"], "init-receipt.json", {"schema": schema("init-receipt"), "projectRoot": str(root), "configuration": str(directory / "project.json"), "inputProvenance": rendered["provenance"]})
    session.update(result={"configuration": "created", "project": str(root)}, state="completed", next={"type": "automatic", "action": "backup", "command": "workspace-recover backup"})
    store.set_info(session, "init", short=f"Project configuration created: {root}", medium=f"Configuration: {directory / 'project.json'}\nLocal values: {directory / 'values.local.json'}\nNext operation: backup", full_path=full)
    return store.save(session)


def start_init(store, template_path, project_root, values, provenance):
    root = Path(project_root).absolute()
    session = store.create("init", projectRoot=str(root), inputs=values, inputProvenance=provenance)
    def start():
        if (root / ".workspace-recover").exists(): raise ValueError("project configuration already exists; init never overwrites it")
        if not root.is_dir(): raise ValueError("project root must be an existing directory")
        template = assert_format(read_json(template_path), "template")
        store.write(session["id"], "template.json", template)
        inputs = deep_merge({"projectName": root.name, "sourcePath": str(root)}, values)
        if inputs.get("projectName") is None: inputs["projectName"] = root.name
        if inputs.get("sourcePath") is None: inputs["sourcePath"] = str(root)
        store.write(session["id"], "values.json", {"schema": schema("values"), "values": inputs})
        return resolve_init(store, session, template, inputs)
    return store.attempt(session, start)

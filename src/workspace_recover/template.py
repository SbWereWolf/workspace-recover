"""Author template validation/layering, using CE's parameter implementation."""
from copy import deepcopy
import json
from pathlib import Path
import re
from command_execution.documents import loads
from urllib.parse import urlparse
from .formats import assert_format, schema
from .util import deep_merge, get_path, set_path, parse_scalar, read_json, write_json, render, integer

TYPES = {"string", "number", "integer", "boolean", "array", "object", "path", "email", "url", "enum", "google-drive-folder"}


def load_values(files=(), sets=(), json_sets=()):
    value, provenance = {}, {}
    layers = []
    for file in files:
        document = assert_format(read_json(file), "values")
        if not isinstance(document.get("values"), dict):
            raise ValueError("values document requires an object values")
        layers.append(("values:" + str(Path(file).absolute()), document["values"]))
    for items, source, decode in ((sets, "--set", parse_scalar), (json_sets, "--set-json", lambda text: loads(text, "wr-json-v1"))):
        for item in items:
            key, sep, text = item.partition("=")
            if not sep or not key:
                raise ValueError(f"{source} requires key=value")
            selected = {}
            set_path(selected, key, decode(text))
            layers.append((source, selected))
    for source, selected in layers:
        for key, item in leaves(selected):
            provenance.setdefault(key, []).append({"source": source, "value": item})
        value = deep_merge(value, selected)
    return value, provenance


def leaves(value, prefix=""):
    result = []
    for key, item in value.items():
        dotted = prefix + "." + key if prefix else key
        get_path({}, dotted)
        if isinstance(item, dict) and item:
            result.extend(leaves(item, dotted))
        else:
            result.append((dotted, item))
    return result


def render_value(value, values, deferred=()):
    missing = set()
    selected = render(value, values, "wr-template", deferred=deferred, missing=missing)
    return selected, sorted(missing)


def matches(definition, value):
    kind = definition.get("type", "string")
    if value is None:
        return definition.get("nullable") is True
    if kind == "string": return isinstance(value, str)
    if kind == "path": return isinstance(value, str) and bool(value) and "\0" not in value
    if kind == "integer": return integer(value)
    if kind == "number": return type(value) in (int, float) and value == value and abs(value) != float("inf")
    if kind == "boolean": return type(value) is bool
    if kind == "array": return isinstance(value, list)
    if kind == "object": return isinstance(value, dict)
    if kind == "email": return isinstance(value, str) and bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))
    if kind == "url": return isinstance(value, str) and urlparse(value).scheme in ("http", "https", "file")
    if kind == "google-drive-folder": return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]+|https://drive\.google\.com/drive/folders/[A-Za-z0-9_-]+(?:[/?#].*)?", value))
    if kind == "enum":
        from command_execution.documents import stringify
        return any(stringify(value) == stringify(item) for item in definition.get("enum", []))
    return False


def render_template(template, supplied=None, supplied_provenance=None):
    assert_format(template, "template")
    supplied = supplied or {}
    definitions = template.get("inputs", {})
    values = {}
    for key, definition in definitions.items():
        if "default" in definition:
            set_path(values, key, deepcopy(definition["default"]))
    values = deep_merge(values, supplied)
    absent = object()
    for _ in range(20):
        changed = False
        for key, definition in definitions.items():
            if definition.get("derive") and get_path(values, key, absent) is absent:
                selected, missing = render_value(definition["derive"], values)
                if not missing:
                    set_path(values, key, selected)
                    changed = True
        if not changed: break
    missing, errors, provenance = [], [], {}
    for key, definition in definitions.items():
        kind = definition.get("type", "string")
        if kind not in TYPES: raise ValueError(f"unsupported input type: {kind}")
        value = get_path(values, key, absent)
        if definition.get("required") and (value is absent or value is None or value == ""):
            missing.append(key)
        elif value is not absent and not matches(definition, value):
            errors.append({"key": key, "message": f"template input {key} must be {kind}"})
        origins = []
        if "default" in definition: origins.append({"source": "default", "value": definition["default"]})
        related = [entry for name, entries in (supplied_provenance or {}).items()
                   if name == key or name.startswith(key + ".") or key.startswith(name + ".") for entry in entries]
        if related: origins.extend(related)
        elif get_path(supplied, key, absent) is not absent: origins.append({"source": "supplied", "value": get_path(supplied, key)})
        elif definition.get("derive") and value is not absent: origins.append({"source": "derived", "expression": definition["derive"], "value": value})
        provenance[key] = origins
    for key, _ in leaves(supplied):
        if not any(key == d or key.startswith(d + ".") or d.startswith(key + ".") for d in definitions):
            errors.append({"key": key, "message": f"unknown template input: {key}"})
    manifest = deepcopy(template.get("manifest"))
    declarations = {key: manifest.pop(key) for key in ("actions", "reporters") if key in manifest}
    restore = manifest.get("restore", {})
    workflow = restore.pop("workflow", None)
    profile = manifest.pop("archiveProfile", None)
    selected, unresolved = render_value(manifest, values)
    if profile is not None:
        from .archive_profile import PLACEHOLDERS
        reserved = [*PLACEHOLDERS, *("bootstrap." + item["id"] for item in profile.get("bootstrap", []))]
        selected["archiveProfile"], missing_profile = render_value(profile, values, reserved)
        unresolved.extend(missing_profile)
    if workflow is not None:
        selected.setdefault("restore", {})["workflow"], missing_workflow = render_value(workflow, values, ("workspace", "stepDir", "operation"))
        unresolved.extend(missing_workflow)
    for key, value in declarations.items():
        selected[key], missing_declaration = render_value(value, values, ("workspace", "stepDir", "operation"))
        unresolved.extend(missing_declaration)
    return {"manifest": selected, "values": values, "missing": sorted(set(missing + unresolved)), "errors": errors, "provenance": provenance}


def describe_inputs(template):
    assert_format(template, "template")
    return {"schema": schema("input-requirements"), "template": template.get("name"), "inputs": template.get("inputs", {})}


def record_input_batch(store, session, template, rendered):
    needs = list(dict.fromkeys([*rendered["missing"], *(error["key"] for error in rendered["errors"])]))
    form = {}
    for key in needs: set_path(form, key, get_path(rendered["values"], key))
    values_file = store.write(session["id"], "missing-values.json", {"schema": schema("values"), "values": form})
    requirements_file = store.write(session["id"], "input-requirements.json", {**describe_inputs(template), "missing": rendered["missing"], "errors": rendered["errors"], "valuesFile": values_file})
    session["state"] = "waiting_for_input"
    session["next"] = {"type": "manual", "action": "provide-input", "required": rendered["missing"], "errors": rendered["errors"], "valuesFile": values_file, "requirementsFile": requirements_file,
                       "command": f"workspace-recover continue {session['id']} --values {json.dumps(values_file)}"}
    session["inputProvenance"] = rendered["provenance"]
    store.write(session["id"], "values.json", {"schema": schema("values"), "values": rendered["values"]})
    return store.save(session)

"""Compile named author declarations to frozen explicit workflow commands."""
from copy import deepcopy
import re
from .formats import assert_format, assert_requirements
from .workflow import validate_workflow
from .reporting import validate_reporter


def compile_manifest(document):
    assert_format(document, "manifest")
    assert_requirements(document.get("requires"))
    manifest = deepcopy(document)
    actions, reporters = manifest.get("actions", {}), manifest.get("reporters", {})
    if not isinstance(actions, dict) or not isinstance(reporters, dict): raise ValueError("actions and reporters must be objects")
    for identifier in [*actions, *reporters]:
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", identifier) or identifier in ("__proto__", "constructor", "prototype"): raise ValueError("unsafe declaration ID")
    workflow = manifest.get("restore", {}).get("workflow", [])
    if not isinstance(workflow, list): raise ValueError("workflow must be an array")
    expanded = []
    for item in workflow:
        name = item if isinstance(item, str) else item.get("action") if isinstance(item, dict) else None
        if name is not None:
            if name not in actions: raise ValueError(f"unknown action: {name}")
            if not isinstance(actions[name], dict): raise ValueError(f"invalid action: {name}")
            step = {**deepcopy(actions[name]), "id": name, **(item if isinstance(item, dict) else {})}
            step.pop("action", None)
        else: step = deepcopy(item)
        if "exec" in step:
            if "argv" in step: raise ValueError(f"action {step.get('id')} declares both exec and argv")
            step["argv"] = step.pop("exec")
        if isinstance(step.get("report"), str):
            if step["report"] not in reporters: raise ValueError(f"unknown reporter: {step['report']}")
            step["report"] = deepcopy(reporters[step["report"]])
        if step.get("report"): validate_reporter(step["report"])
        expanded.append(step)
    validate_workflow(expanded)
    from .archive_profile import validate_archive_profile
    validate_archive_profile(manifest.get("archiveProfile"))
    manifest["restore"] = {**manifest.get("restore", {}), "workflow": expanded}
    manifest.pop("actions", None)
    manifest.pop("reporters", None)
    manifest.setdefault("requires", {"formatVersion": 3, "features": ["advisory-workflow", "saved-reports"]})
    return manifest

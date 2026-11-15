"""Declared trusted archive command pairs and independently retained bootstrap."""
from copy import deepcopy
import gzip
import hashlib
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
import tempfile
from .formats import assert_format
from .selection import identity, selection_inventory, assert_inventory
from .tar_format import archive_name
from .archive import create_tar_gz, extract_tar_gz, verify_tar_inventory
from .target_tree import TargetTree
from .workflow import validate_workflow, execute_workflow
from .util import sha256_file, write_text

PLACEHOLDERS = ["sourceRoot", "targetRoot", "archivePath", "selectionNul", "workspace", "stepDir", "operation"]


def validate_archive_profile(profile, resolved=False):
    if profile is None: return None
    assert_format(profile, "archive-profile")
    if profile.get("kind") != "exec" or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,31}", profile.get("format", "")): raise ValueError("invalid archive profile kind or format")
    if not isinstance(profile.get("bootstrap", []), list): raise ValueError("profile bootstrap must be an array")
    seen = set()
    for item in profile.get("bootstrap", []):
        identifier = item.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", identifier) or identifier in ("constructor", "prototype", "__proto__") or identifier in seen: raise ValueError("invalid bootstrap ID")
        seen.add(identifier)
        if resolved:
            if type(item.get("bytes")) is not int or item["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")) or not isinstance(item.get("remote", {}).get("id"), str) or not item["remote"]["id"] or type(item.get("mode")) is not int or not 0 <= item["mode"] <= 0o777: raise ValueError("invalid resolved bootstrap reference")
        elif not isinstance(item.get("path"), str) or not item["path"] or "\0" in item["path"] or ("sha256" in item and not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])): raise ValueError("invalid bootstrap source")
    allowed = {*PLACEHOLDERS, *("bootstrap." + item for item in seen)}
    def strings(value):
        if isinstance(value, str): yield value
        elif isinstance(value, dict):
            for child in value.values(): yield from strings(child)
        elif isinstance(value, list):
            for child in value: yield from strings(child)
    for name in ("pack", "unpack"):
        command = profile.get(name)
        if not isinstance(command, dict): raise ValueError(f"archive profile requires {name}")
        if "shell" in command: raise ValueError("archive profile does not accept shell strings")
        validate_workflow([{**command, "id": name, "type": "command"}])
        for value in strings(command):
            for key in re.findall(r"\$\{([^}]+)\}", value):
                if key not in allowed: raise ValueError(f"unknown archive profile placeholder: {key}")
            forbidden = "targetRoot" if name == "pack" else "sourceRoot"
            if "${" + forbidden + "}" in value: raise ValueError(f"{name} cannot depend on {forbidden}")
    executables = profile.get("requires", {}).get("executables", [])
    if not isinstance(executables, list) or any(not isinstance(x, str) or not x or "\0" in x for x in executables): raise ValueError("invalid profile executable requirements")
    return deepcopy(profile)


def regular_hash(file, expected=None):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or (expected is not None and identity(before) != expected): raise ValueError(f"source changed or not a regular file: {file}")
        digest, total = hashlib.sha256(), 0
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
            total += len(data)
        if total != before.st_size or identity(before) != identity(os.fstat(stream.fileno())): raise ValueError(f"source changed during hashing: {file}")
        return {"sha256": digest.hexdigest(), "bytes": total, "mode": stat.S_IMODE(before.st_mode), "identity": identity(before)}


def require_executables(profile):
    for name in (profile or {}).get("requires", {}).get("executables", []):
        target = Path(name).absolute() if os.sep in name else Path(shutil.which(name) or "")
        if not target.is_file() or not os.access(target, os.X_OK): raise ValueError(f"required archive executable not found: {name}")


def prepare_bootstrap(profile, session_dir):
    refs = []
    for item in (profile or {}).get("bootstrap", []):
        source = Path(item["path"]).absolute()
        meta = regular_hash(source)
        if item.get("sha256") and item["sha256"] != meta["sha256"]: raise ValueError(f"bootstrap hash mismatch: {item['id']}")
        file = Path(session_dir) / "bootstrap" / item["id"]
        file.parent.mkdir(parents=True, exist_ok=True)
        if file.exists():
            if sha256_file(file) != meta["sha256"]: raise ValueError("frozen bootstrap changed")
        else:
            with file.open("xb") as out, source.open("rb") as stream: shutil.copyfileobj(stream, out)
        if sha256_file(file) != meta["sha256"]: raise ValueError("bootstrap copy changed")
        file.chmod(meta["mode"] & 0o777)
        refs.append({"id": item["id"], "path": str(file), "bytes": meta["bytes"], "sha256": meta["sha256"], "mode": meta["mode"] & 0o777})
    return refs


def bootstrap_context(refs): return {"bootstrap." + item["id"]: item["path"] for item in refs}


def resolved_profile(profile, refs):
    if not profile: return None
    value = deepcopy(profile)
    value["bootstrap"] = [{key: item[key] for key in ("id", "bytes", "sha256", "mode", "remote")} for item in refs]
    return validate_archive_profile(value, True)


def fetch_bootstrap(profile, provider, directory, folder=None, fresh=False):
    refs = []
    for item in (profile or {}).get("bootstrap", []):
        file = Path(directory) / "bootstrap" / item["id"]
        file.parent.mkdir(parents=True, exist_ok=True)
        if fresh or not file.exists() or file.stat().st_size != item["bytes"] or sha256_file(file) != item["sha256"]:
            provider.download(item["remote"], file, expected_folder_id=folder, expected_bytes=item["bytes"], expected_sha256=item["sha256"])
        if file.stat().st_size != item["bytes"] or sha256_file(file) != item["sha256"]: raise ValueError(f"bootstrap download mismatch: {item['id']}")
        file.chmod(item["mode"])
        refs.append({**item, "path": str(file)})
    return refs


def command(profile, name, context, workspace, session_dir):
    result = execute_workflow([{**profile[name], "id": name, "type": "command"}], workspace, Path(session_dir) / name, context)
    if result["hardFailure"]: raise ValueError(f"archive {name} failed; exit={result['results'][0].get('exitCode')}; see {result['workflowReport']['fullPath']}")
    return result["results"][0]["report"]


def verify_archive_inventory(archive, inventory):
    with tempfile.TemporaryDirectory(prefix="workspace-recover-inventory-") as directory:
        spool = Path(directory) / "archive.tar"
        with gzip.open(archive, "rb") as source, spool.open("xb") as out: shutil.copyfileobj(source, out, 1024 * 1024)
        with spool.open("rb") as stream: verify_tar_inventory(stream, inventory)


def pack_archive(profile, source, output, selection, selection_file, session_dir, bootstrap):
    if not profile: return create_tar_gz(source, output, selection=selection)
    validate_archive_profile(profile)
    require_executables(profile)
    output = Path(output)
    actual, root = output.resolve(), Path(selection["sourceRoot"])
    if actual == root or root in actual.parents: raise ValueError("archive output must be outside source")
    if os.path.lexists(output): raise ValueError("archive output already exists")
    for entry in selection["entries"]:
        if entry["type"] == "0": entry["sha256"] = regular_hash(entry["absolute"], entry["identity"])["sha256"]
    inventory = assert_inventory(selection_inventory(selection))
    report = command(profile, "pack", {"sourceRoot": str(root), "selectionNul": str(selection_file), "archivePath": str(output), "operation": "pack", **bootstrap_context(bootstrap)}, root, session_dir)
    for entry in [*selection["entries"], *selection["watched"]]:
        if identity(os.lstat(entry["absolute"])) != entry["identity"]: raise ValueError(f"source changed during external capture: {entry['name']}")
    captured = regular_hash(output)
    if profile["format"] == "tar.gz": verify_archive_inventory(output, inventory)
    return {"output": str(output), "bytes": captured["bytes"], "sha256": captured["sha256"], "entries": [e["name"] for e in selection["entries"]], "inventory": inventory, "packReport": report}


def verify_workspace_inventory(target, inventory, allow_extra=False):
    assert_inventory(inventory)
    expected, seen = {e["path"]: e for e in inventory["entries"]}, set()
    def visit(relative):
        file = Path(target) if relative == "." else Path(target) / relative
        value = file.lstat()
        entry = expected.get(relative)
        seen.add(relative)
        if entry is None:
            if not allow_extra: raise ValueError(f"unexpected restored inventory path: {relative}")
            return
        kind = "symlink" if stat.S_ISLNK(value.st_mode) else "directory" if stat.S_ISDIR(value.st_mode) else "file" if stat.S_ISREG(value.st_mode) else "unsupported"
        if kind != entry["type"] or stat.S_IMODE(value.st_mode) != entry["mode"]: raise ValueError(f"restored inventory type/mode mismatch: {relative}")
        if kind == "file":
            meta = regular_hash(file, identity(value))
            if meta["bytes"] != entry["bytes"] or meta["sha256"] != entry["sha256"]: raise ValueError(f"restored inventory bytes mismatch: {relative}")
        if kind == "symlink":
            if not entry.get("target") or entry["target"].startswith("/") or re.match(r"^[A-Za-z]:", entry["target"]): raise ValueError("unsafe restored inventory link")
            archive_name(posixpath.normpath(posixpath.join(posixpath.dirname(entry["path"]), entry["target"])))
            if os.readlink(file) != entry["target"]: raise ValueError(f"restored inventory link mismatch: {relative}")
        if kind == "directory":
            for name in os.listdir(file): visit(name if relative == "." else relative + "/" + name)
    visit(".")
    if set(expected) - seen: raise ValueError("missing restored inventory path")


def unpack_archive(profile, archive, destination, reject_existing, inventory, session_dir, bootstrap):
    if not profile:
        extract_tar_gz(archive, destination, reject_existing=reject_existing, inventory=inventory)
        return None
    validate_archive_profile(profile, True)
    require_executables(profile)
    if not inventory: raise ValueError("external archive profile requires selection inventory")
    assert_inventory(inventory)
    for entry in inventory["entries"]:
        if entry["type"] == "symlink":
            if not entry.get("target") or entry["target"].startswith("/") or re.match(r"^[A-Za-z]:", entry["target"]): raise ValueError("unsafe inventory symlink")
            archive_name(posixpath.normpath(posixpath.join(posixpath.dirname(entry["path"]), entry["target"])))
    if profile["format"] == "tar.gz": verify_archive_inventory(archive, inventory)
    if not reject_existing: raise ValueError("external archive profiles require a new target; use builtin for safe merge")
    tree = TargetTree(destination, True)
    tree.close()
    listing = Path(session_dir) / "unpack-selection.nul"
    write_text(listing, ("\0".join(e["path"] for e in inventory["entries"]) + "\0").encode())
    report = command(profile, "unpack", {"targetRoot": str(Path(destination).absolute()), "archivePath": str(archive), "selectionNul": str(listing), "operation": "unpack", **bootstrap_context(bootstrap)}, destination, session_dir)
    verify_workspace_inventory(destination, inventory)
    return report

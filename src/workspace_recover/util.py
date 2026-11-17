"""WR paths, identities and persistence; pure data transformations use CE."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
from . import json_files
from command_execution import JSONMerger, JSONPathEditor
from command_execution.parameters import render, lookup, js_string

APP_NAME = "workspace-recover"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def session_id(prefix="wr"):
    return prefix + "_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(6)


def home_dir(kind):
    variable, xdg, default = {"config": ("CONFIG", "XDG_CONFIG_HOME", ".config"),
        "state": ("STATE", "XDG_STATE_HOME", ".local/state"),
        "cache": ("CACHE", "XDG_CACHE_HOME", ".cache")}[kind]
    return Path(os.environ.get(f"WORKSPACE_RECOVER_{variable}_DIR") or
                str(Path(os.environ.get(xdg) or Path.home() / default) / APP_NAME))


def exists(path):
    return os.path.lexists(path)


def read_json(path, *, strip_bom=False):
    return json_files.read_json(path, "wr-json-v1", strip_bom=strip_bom)


def write_json(path, value, mode=0o600):
    json_files.write_json(path, value, profile="wr-json-v1", new_file_mode=mode)
    return str(path)


def write_text(path, value, mode=0o600):
    json_files.write_text(path, value, new_file_mode=mode)
    return str(path)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def canonical(value):
    return json_files.stringify(value, canonical=True)


def safe_key(key):
    if not isinstance(key, str) or not key or any(not x or x in ("__proto__", "constructor", "prototype") for x in key.split(".")):
        raise ValueError("unsafe or reserved value key")


def get_path(value, key, default=None):
    safe_key(key)
    try:
        return lookup(value, key, "wr-template")
    except KeyError:
        return default


def set_path(value, key, selected):
    safe_key(key)
    changed = JSONPathEditor().set(value, key, selected, profile='dotted')
    value.clear()
    value.update(changed)


def deep_merge(base, overlay):
    def validate(value):
        if isinstance(value, dict):
            for key, child in value.items():
                safe_key(key)
                validate(child)
    validate(overlay)
    return JSONMerger().merge(base, overlay)


def parse_scalar(value):
    if value in ("true", "false", "null"):
        return {"true": True, "false": False, "null": None}[value]
    if re.fullmatch(r"-?\d+(\.\d+)?", value):
        return float(value)
    return value


def copy_verified(source, target):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    digest = sha256_file(source)
    if sha256_file(target) != digest:
        raise ValueError(f"copy verification failed: {source} -> {target}")
    return digest


def resource_path(*parts):
    from importlib.resources import files
    return Path(str(files("workspace_recover").joinpath("resources", *parts)))


def file_record(path):
    path = Path(path).absolute()
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def integer(value):
    return type(value) in (int, float) and abs(value) <= 9007199254740991 and int(value) == value

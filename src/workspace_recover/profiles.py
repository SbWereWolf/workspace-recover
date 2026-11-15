"""Caller-owned local profile declarations."""
from command_execution.documents import create_json
from pathlib import Path
import re
from .formats import schema, assert_format
from .util import home_dir, read_json


def profile_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name) or name in ("constructor", "prototype"):
        raise ValueError("invalid local profile name")
    return name


def validate_profile(value):
    assert_format(value, "profile")
    if set(value) - {"schema", "name", "workspaceRoot", "googleProfile"}:
        raise ValueError("unknown profile field")
    if "name" in value: profile_name(value["name"])
    if "workspaceRoot" in value and (not isinstance(value["workspaceRoot"], str) or not Path(value["workspaceRoot"]).is_absolute() or "\0" in value["workspaceRoot"]):
        raise ValueError("workspaceRoot must be an absolute local path")
    if "googleProfile" in value: profile_name(value["googleProfile"])
    return value


def load_profile(name="default", optional=False):
    file = home_dir("config") / "profiles" / (profile_name(name) + ".json")
    if optional and not file.exists(): return None
    if not file.exists(): raise ValueError(f"Local profile missing: {file}")
    return validate_profile(read_json(file))


def create_profile(name, values):
    profile_name(name)
    if set(values) - {"workspaceRoot", "googleProfile"}: raise ValueError("unknown profile value(s)")
    value = validate_profile({"schema": schema("profile"), "name": name, **values})
    file = home_dir("config") / "profiles" / (name + ".json")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    create_json(file, value, profile="wr-json-v1", new_file_mode=0o600)
    return {"file": str(file), "document": value}


def list_profiles():
    directory = home_dir("config") / "profiles"
    return sorted(file.stem for file in directory.glob("*.json"))

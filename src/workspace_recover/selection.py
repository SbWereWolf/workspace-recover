"""Source-relative glob selection and the versioned byte inventory."""
from functools import lru_cache
import os
from pathlib import Path
import posixpath
import re
import stat
from .formats import schema, assert_format
from .tar_format import archive_name


def validate_selection(includes=None, excludes=None):
    def parse(patterns, label):
        if not isinstance(patterns, list): raise ValueError(f"{label} patterns must be an array")
        result = []
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern or "\0" in pattern or pattern.startswith("/") or re.match(r"^[A-Za-z]:", pattern): raise ValueError(f"invalid relative selection pattern: {pattern}")
            value = pattern.removeprefix("./").removesuffix("/")
            parts = value.split("/")
            if any(not part or part in (".", "..") or ("**" in part and part != "**") for part in parts): raise ValueError(f"invalid selection pattern: {pattern}")
            result.append({"pattern": pattern, "segments": parts, "directoryOnly": pattern.endswith("/")})
        return result
    return {"include": parse(["**"] if includes is None else includes, "include"), "exclude": parse([] if excludes is None else excludes, "exclude")}


def match_segments(pattern, parts, prefix=False):
    @lru_cache(None)
    def match(i, j):
        if j == len(parts): return prefix or all(x == "**" for x in pattern[i:])
        if i == len(pattern): return False
        if pattern[i] == "**": return match(i + 1, j) or match(i, j + 1)
        regex = re.escape(pattern[i]).replace(r"\*", "[^/]*").replace(r"\?", "[^/]")
        return bool(re.fullmatch(regex, parts[j])) and match(i + 1, j + 1)
    return match(0, 0)


def identity(value): return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def select_source(source, includes=None, excludes=None):
    includes, excludes = ["**"] if includes is None else includes, [] if excludes is None else excludes
    rules, root = validate_selection(includes, excludes), Path(source).resolve(strict=True)
    if not root.is_dir(): raise ValueError("backup source must be a directory")
    chosen, directories, watched = {}, {}, []
    visited, excluded = 0, 0
    def entry(path, relative, value, kind):
        return {"absolute": str(path), "name": (relative + "/" if kind == "5" else relative) if relative else "./", "type": kind,
                "mode": stat.S_IMODE(value.st_mode), "size": value.st_size if kind == "0" else 0,
                "mtimeMs": value.st_mtime_ns / 1000000, "identity": identity(value)}
    def visit(path, relative, inherited):
        nonlocal visited, excluded
        value = path.lstat()
        directory = stat.S_ISDIR(value.st_mode)
        visited += 1
        parts = relative.split("/") if relative else []
        if relative and any((not p["directoryOnly"] or directory) and match_segments(p["segments"], parts) for p in rules["exclude"]):
            excluded += 1
            return
        direct = [p["pattern"] for p in rules["include"] if (not p["directoryOnly"] or directory) and match_segments(p["segments"], parts)] if relative else []
        reasons = list(dict.fromkeys([*inherited, *direct]))
        if directory:
            selected = entry(path, relative, value, "5")
            directories[relative] = selected
            if not relative or reasons: chosen[relative] = {**selected, "reasons": reasons if relative else ["root-metadata"]}
            if relative and not reasons and not any(match_segments(p["segments"], parts, True) for p in rules["include"]): return
            if not relative and not rules["include"]: return
            watched.append(selected)
            names = sorted([raw.decode("utf-8", errors="strict") for raw in os.listdir(os.fsencode(path))])
            for name in names: visit(path / name, relative + "/" + name if relative else name, reasons)
        elif reasons:
            if stat.S_ISREG(value.st_mode): selected = entry(path, relative, value, "0")
            elif stat.S_ISLNK(value.st_mode): selected = {**entry(path, relative, value, "2"), "linkname": os.readlink(os.fsencode(path)).decode("utf-8", errors="strict")}
            else: raise ValueError(f"unsupported selected filesystem entry: {relative}")
            chosen[relative] = {**selected, "reasons": reasons}
    visit(root, "", [])
    for name in list(chosen):
        parent = posixpath.dirname(name) or "."
        while parent != ".":
            if parent not in chosen: chosen[parent] = {**directories[parent], "reasons": ["parent-metadata"]}
            parent = posixpath.dirname(parent) or "."
    return {"sourceRoot": str(root), "patterns": {"include": includes, "exclude": excludes}, "entries": [chosen[name] for name in sorted(chosen)], "watched": watched, "visited": visited, "excluded": excluded}


def selection_inventory(selection):
    entries = []
    for entry in selection["entries"]:
        value = {"path": archive_name(entry["name"]), "type": {"0": "file", "5": "directory", "2": "symlink"}[entry["type"]], "mode": entry["mode"] & 0o7777}
        if entry["type"] == "0": value.update(bytes=entry["size"], sha256=entry.get("sha256"))
        if entry["type"] == "2": value["target"] = entry["linkname"]
        value["reasons"] = entry["reasons"]
        entries.append(value)
    return {"schema": schema("selection"), "patterns": selection["patterns"], "totals": {"entries": len(entries), "files": sum(e["type"] == "file" for e in entries), "bytes": sum(e.get("bytes", 0) for e in entries), "visited": selection["visited"], "excludedRoots": selection["excluded"]}, "entries": entries}


def assert_inventory(value):
    assert_format(value, "selection")
    if not isinstance(value.get("entries"), list): raise ValueError("inventory entries must be an array")
    seen = set()
    for entry in value["entries"]:
        if not isinstance(entry, dict) or archive_name(entry.get("path")) != entry["path"] or entry["path"] in seen: raise ValueError("unsafe or duplicate inventory path")
        seen.add(entry["path"])
        if entry.get("type") not in ("file", "directory", "symlink") or type(entry.get("mode")) is not int or not 0 <= entry["mode"] <= 0o7777: raise ValueError("invalid inventory entry metadata")
        if entry["type"] == "file" and (type(entry.get("bytes")) is not int or entry["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", ""))): raise ValueError("invalid inventory file bytes or hash")
        if entry["type"] == "symlink" and (not isinstance(entry.get("target"), str) or "\0" in entry["target"]): raise ValueError("invalid inventory symlink")
    if not any(e["path"] == "." and e["type"] == "directory" for e in value["entries"]): raise ValueError("inventory requires root directory metadata")
    return value


def selection_nul(selection):
    return ("\0".join("." if e["name"] == "./" else e["name"].rstrip("/") for e in selection["entries"]) + "\0").encode("utf-8")

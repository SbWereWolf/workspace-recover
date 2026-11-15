"""Streaming archive transport, inventory verification and bounded file parts."""
import gzip
import hashlib
import math
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from .selection import select_source, identity, selection_inventory, assert_inventory
from .tar_format import tar_entries, padding
from .target_tree import TargetTree
from .util import sha256_file


def create_tar_gz(source, output, *, includes=None, excludes=None, selection=None):
    root, output = Path(source).resolve(strict=True), Path(output)
    actual = output.resolve()
    if actual == root or root in actual.parents: raise ValueError("backup output must be outside source")
    selection = selection if selection is not None else select_source(root, includes, excludes)
    if selection["sourceRoot"] != str(root): raise ValueError("selection source mismatch")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, mtime=0, fileobj=raw) as compressed:
            for entry in selection["entries"]:
                info = tarfile.TarInfo(entry["name"])
                info.mode, info.uid, info.gid = entry["mode"] & 0o7777, 0, 0
                info.uname = info.gname = "workspace-recover"
                info.mtime = math.floor(entry["mtimeMs"] / 1000)
                info.size = entry["size"]
                info.type = entry["type"].encode("ascii")
                if entry["type"] == "2": info.linkname = entry["linkname"]
                compressed.write(info.tobuf(format=tarfile.PAX_FORMAT, encoding="utf-8", errors="strict"))
                if entry["type"] == "0":
                    handle = os.open(entry["absolute"], os.O_RDONLY | os.O_NOFOLLOW)
                    digest = hashlib.sha256()
                    with os.fdopen(handle, "rb") as stream:
                        if identity(os.fstat(stream.fileno())) != entry["identity"]: raise ValueError(f"source changed during backup: {entry['name']}")
                        remaining = entry["size"]
                        while remaining:
                            data = stream.read(min(1024 * 1024, remaining))
                            if not data: raise ValueError(f"source shrank during backup: {entry['name']}")
                            digest.update(data)
                            compressed.write(data)
                            remaining -= len(data)
                        if identity(os.fstat(stream.fileno())) != entry["identity"]: raise ValueError(f"source changed during backup: {entry['name']}")
                    entry["sha256"] = digest.hexdigest()
                    compressed.write(b"\0" * padding(entry["size"]))
            for entry in [*selection["entries"], *selection["watched"]]:
                if identity(os.lstat(entry["absolute"])) != entry["identity"]: raise ValueError(f"source changed during backup: {entry['name']}")
            compressed.write(b"\0" * 1024)
    return {"output": str(output), "bytes": output.stat().st_size, "sha256": sha256_file(output),
            "entries": [entry["name"] for entry in selection["entries"]], "inventory": selection_inventory(selection)}


def verify_tar_inventory(stream, inventory, on_entry=None):
    assert_inventory(inventory)
    expected, seen = {entry["path"]: entry for entry in inventory["entries"]}, set()
    for entry in tar_entries(stream):
        kind = {"0": "file", "5": "directory", "2": "symlink"}[entry["type"]]
        selected = expected.get(entry["name"])
        if selected is None or entry["name"] in seen or selected["type"] != kind or selected["mode"] != entry["mode"]: raise ValueError(f"inventory metadata mismatch: {entry['name']}")
        seen.add(entry["name"])
        if kind == "symlink" and selected["target"] != entry["linkname"]: raise ValueError(f"inventory symlink mismatch: {entry['name']}")
        if kind == "file":
            if selected["bytes"] != entry["size"]: raise ValueError(f"inventory size mismatch: {entry['name']}")
            digest = hashlib.sha256()
            remaining, position = entry["size"], entry["offset"]
            while remaining:
                data = os.pread(stream.fileno(), min(1024 * 1024, remaining), position)
                if not data: raise ValueError("truncated inventory data")
                digest.update(data)
                remaining, position = remaining - len(data), position + len(data)
            if digest.hexdigest() != selected["sha256"]: raise ValueError(f"inventory hash mismatch: {entry['name']}")
        if on_entry: on_entry(entry)
    if len(seen) != len(expected): raise ValueError("inventory has missing archive entries")
    return {"entries": len(seen), "verified": True}


def extract_tar_gz(archive, destination, *, reject_existing=True, inventory=None):
    tree = TargetTree(destination, reject_existing)
    try:
        with tempfile.TemporaryDirectory(prefix="workspace-recover-tar-") as scratch:
            spool = Path(scratch) / "payload.tar"
            with gzip.open(archive, "rb") as source, spool.open("xb") as out: shutil.copyfileobj(source, out, 1024 * 1024)
            with spool.open("rb") as stream:
                def materialize(entry):
                    if entry["type"] == "5": tree.directory_entry(entry)
                    elif entry["type"] == "2": tree.symlink_entry(entry)
                    else: tree.file_entry(entry, stream)
                if inventory: verify_tar_inventory(stream, inventory, materialize)
                else:
                    for entry in tar_entries(stream): materialize(entry)
            tree.finish()
    except Exception:
        tree.finish(best_effort=True)
        raise
    finally:
        tree.close()
    return str(destination)


def split_file(file, output_directory, max_part_bytes=64 * 1024 * 1024):
    if type(max_part_bytes) is not int or max_part_bytes < 1: raise ValueError("maxPartBytes must be a positive integer")
    file, directory = Path(file), Path(output_directory)
    directory.mkdir(parents=True, exist_ok=True)
    parts = []
    with file.open("rb") as source:
        index = 0
        while source.tell() < file.stat().st_size:
            name = file.name + f".part-{index:03}"
            path, remaining = directory / name, min(max_part_bytes, file.stat().st_size - source.tell())
            size = remaining
            with path.open("wb") as out:
                while remaining:
                    data = source.read(min(1024 * 1024, remaining))
                    if not data: raise ValueError("unexpected EOF while splitting archive")
                    out.write(data)
                    remaining -= len(data)
            parts.append({"index": index, "fileName": name, "path": str(path), "bytes": size, "sha256": sha256_file(path)})
            index += 1
    return parts


def assemble_parts(parts, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".wr-assembly-", dir=output.parent) as scratch:
        candidate = Path(scratch) / "archive"
        with candidate.open("xb") as out:
            for part in sorted(parts, key=lambda item: item["index"]):
                path = Path(part["path"])
                if os.path.abspath(path) == os.path.abspath(output): raise ValueError("assembled archive must not overwrite an input part")
                if "bytes" in part and path.stat().st_size != part["bytes"]: raise ValueError(f"part size mismatch: {part['fileName']}")
                if part.get("sha256") and sha256_file(path) != part["sha256"]: raise ValueError(f"part sha256 mismatch: {part['fileName']}")
                with path.open("rb") as stream: shutil.copyfileobj(stream, out, 1024 * 1024)
        candidate.replace(output)
    return {"output": str(output), "bytes": output.stat().st_size, "sha256": sha256_file(output)}

"""Descriptor-relative restore materialization preserving existing boundaries."""
from contextlib import contextmanager
import os
from pathlib import Path
import posixpath
import re
import stat
import uuid
from .tar_format import archive_name

FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def lstat_at(fd, name):
    try: return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError: return None


def validate(fd, path):
    selected, held = os.lstat(path), os.fstat(fd)
    if not stat.S_ISDIR(selected.st_mode) or (selected.st_dev, selected.st_ino) != (held.st_dev, held.st_ino) or os.path.realpath(path) != str(path):
        raise ValueError(f"restore directory changed or became a symlink: {path}")
    if Path("/proc/self/fd").exists() and os.path.realpath(f"/proc/self/fd/{fd}") != str(path):
        raise ValueError(f"restore directory changed: {path}")


class TargetTree:
    def __init__(self, destination, reject_existing=True):
        self.root = Path(os.path.abspath(destination))
        self.modes = {}
        if self.root == Path("/"): raise ValueError("refusing filesystem root as restore target")
        if reject_existing and os.path.lexists(self.root): raise ValueError(f"restore target already exists: {self.root}")
        current = Path("/")
        fd = os.open(current, FLAGS)
        try:
            for index, part in enumerate(self.root.parts[1:]):
                validate(fd, current)
                present = lstat_at(fd, part)
                if present is None:
                    try: os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError: pass
                elif reject_existing and index == len(self.root.parts) - 2:
                    raise ValueError(f"restore target already exists: {self.root}")
                next_fd = os.open(part, FLAGS, dir_fd=fd)
                os.close(fd)
                fd, current = next_fd, current / part
                validate(fd, current)
            self.fd = fd
        except Exception:
            os.close(fd)
            raise

    @contextmanager
    def directory_for(self, name, create=True):
        name = archive_name(name)
        fd, current = os.dup(self.fd), self.root
        try:
            validate(fd, current)
            if name != ".":
                for part in name.split("/"):
                    validate(fd, current)
                    if lstat_at(fd, part) is None and create:
                        try:
                            os.mkdir(part, 0o700, dir_fd=fd)
                            self.modes[(current / part).relative_to(self.root).as_posix()] = 0o755
                        except FileExistsError: pass
                    next_fd = os.open(part, FLAGS, dir_fd=fd)
                    os.close(fd)
                    fd, current = next_fd, current / part
                    validate(fd, current)
            yield fd, current
        finally:
            os.close(fd)

    def directory_entry(self, entry):
        with self.directory_for(entry["name"]) as (fd, current):
            validate(fd, current)
            self.modes[entry["name"]] = entry["mode"]
            os.fchmod(fd, entry["mode"] | 0o700)

    def file_entry(self, entry, stream):
        with self.directory_for(posixpath.dirname(entry["name"]) or ".") as (fd, current):
            validate(fd, current)
            leaf = posixpath.basename(entry["name"])
            before = lstat_at(fd, leaf)
            if before is not None and not stat.S_ISREG(before.st_mode): raise ValueError(f"unsafe existing restore file or symlink: {entry['name']}")
            temporary = ".wr-extract-" + uuid.uuid4().hex
            out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            try:
                with os.fdopen(out, "wb") as target:
                    remaining, position = entry["size"], entry["offset"]
                    while remaining:
                        data = os.pread(stream.fileno(), min(1024 * 1024, remaining), position)
                        if not data: raise ValueError(f"truncated file data: {entry['name']}")
                        target.write(data)
                        remaining, position = remaining - len(data), position + len(data)
                    target.flush()
                    os.fchmod(target.fileno(), entry["mode"])
                validate(fd, current)
                present = lstat_at(fd, leaf)
                if present is not None and not stat.S_ISREG(present.st_mode): raise ValueError(f"unsafe existing restore file or symlink: {entry['name']}")
                os.rename(temporary, leaf, src_dir_fd=fd, dst_dir_fd=fd)
            except Exception as error:
                raise ValueError(f"{error} (partial entry: {current / temporary})") from error

    def symlink_entry(self, entry):
        with self.directory_for(posixpath.dirname(entry["name"]) or ".") as (fd, current):
            validate(fd, current)
            leaf = posixpath.basename(entry["name"])
            present = lstat_at(fd, leaf)
            if present is not None and (not stat.S_ISLNK(present.st_mode) or os.readlink(leaf, dir_fd=fd) != entry["linkname"]):
                raise ValueError(f"existing entry conflicts with archive symlink: {entry['name']}")
            endpoint = posixpath.normpath(posixpath.join(posixpath.dirname(entry["name"]), entry["linkname"]))
            self.check_link_endpoint(endpoint, {entry["name"]})
            if present is None: os.symlink(entry["linkname"], leaf, dir_fd=fd)

    def check_link_endpoint(self, name, seen):
        archive_name(name)
        parts, prefix = ([] if name == "." else name.split("/")), ""
        for index, part in enumerate(parts):
            with self.directory_for(prefix or ".", False) as (fd, current):
                validate(fd, current)
                value = lstat_at(fd, part)
                if value is None: return
                if stat.S_ISLNK(value.st_mode):
                    link = os.readlink(part, dir_fd=fd)
                    target = posixpath.normpath(posixpath.join(prefix, link, *parts[index + 1:]))
                    if link.startswith("/") or re.match(r"^[A-Za-z]:", link) or target in seen or len(seen) > 40: raise ValueError(f"unsafe or cyclic symlink endpoint: {name}")
                    archive_name(target)
                    return self.check_link_endpoint(target, seen | {target})
                if index < len(parts) - 1 and not stat.S_ISDIR(value.st_mode): raise ValueError(f"symlink endpoint is not a directory: {name}")
            prefix = prefix + "/" + part if prefix else part

    def finish(self, best_effort=False):
        for name, mode in sorted(self.modes.items(), key=lambda pair: 0 if pair[0] == "." else len(pair[0].split("/")), reverse=True):
            try:
                with self.directory_for(name, False) as (fd, current):
                    validate(fd, current)
                    os.fchmod(fd, mode)
            except Exception:
                if not best_effort: raise

    def close(self): os.close(self.fd)

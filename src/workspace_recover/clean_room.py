"""Owned legacy rehearsal area; generic flows impose no rehearsal gate."""
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile


def create_clean_room(identifier):
    if not re.fullmatch(r"wr_[bri]_\d{14}_[a-f0-9]{12}", identifier): raise ValueError("invalid clean-room session ID")
    return tempfile.mkdtemp(prefix="workspace-recover-clean-room-" + identifier + "-")


def remove_clean_room(root):
    root = Path(root)
    if root.parent.resolve() != Path(tempfile.gettempdir()).resolve() or not re.fullmatch(r"workspace-recover-clean-room-wr_[bri]_\d{14}_[a-f0-9]{12}-[A-Za-z0-9_-]+", root.name) or not root.is_dir() or root.is_symlink(): raise ValueError("refusing cleanup outside an owned OS clean room")
    def prepare(directory):
        value = os.lstat(directory)
        if not stat.S_ISDIR(value.st_mode): return
        fd = os.open(directory, getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            held = os.fstat(fd)
            if (held.st_dev, held.st_ino) != (value.st_dev, value.st_ino): raise ValueError("clean-room directory changed during cleanup")
            anchor = Path(f"/proc/self/fd/{fd}")
            os.chmod(anchor, stat.S_IMODE(held.st_mode) | 0o700)
            for entry in os.scandir(anchor):
                if entry.is_dir(follow_symlinks=False): prepare(anchor / entry.name)
        finally: os.close(fd)
    prepare(root)
    shutil.rmtree(root)

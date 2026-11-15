"""Local resource and handoff provider with observed readback."""
from pathlib import Path
from urllib.parse import urlparse, unquote
from ..formats import schema, assert_format
from ..util import copy_verified, read_json, write_json, write_text, sha256_file


class LocalFilesProvider:
    type = "local-files"
    def __init__(self, root, handoff_root=None, read_only=False):
        self.root = Path(root).absolute()
        self.handoff_root = Path(handoff_root).absolute() if handoff_root else self.root / "handoffs"
        self.read_only = read_only

    def ready(self):
        if not self.read_only:
            self.root.mkdir(parents=True, exist_ok=True)
            self.handoff_root.mkdir(parents=True, exist_ok=True)
        return {"ready": True}

    def upload(self, file, name=None, folder_id=None):
        file = Path(file)
        target = self.root / (name or file.name)
        copy_verified(file, target)
        return {"id": str(target), "name": target.name, "url": target.as_uri(), "bytes": target.stat().st_size, "sha256": sha256_file(target), "parent": str(self.root)}

    def metadata(self, reference):
        file = self.path(reference)
        return {"id": str(file), "name": file.name, "bytes": file.stat().st_size, "parent": str(file.parent), "shared": False}

    @staticmethod
    def path(reference):
        value = reference.get("id") or reference.get("path") or reference.get("url") if isinstance(reference, dict) else reference
        return Path(unquote(urlparse(value).path) if str(value).startswith("file://") else value).absolute()

    def download(self, reference, destination, **expected):
        copy_verified(self.path(reference), destination)
        return str(destination)

    def send_handoff(self, session_id, to, subject, body, attachments):
        directory = self.handoff_root / session_id
        directory.mkdir(parents=True, exist_ok=True)
        write_text(directory / "HANDOFF.md", body + "\n", 0o644)
        copied = []
        for item in attachments:
            target = directory / item.get("name", Path(item["path"]).name)
            copy_verified(item["path"], target)
            copied.append({"name": target.name, "path": str(target), "sha256": sha256_file(target)})
        write_json(directory / "handoff.json", {"schema": schema("handoff-local"), "sessionId": session_id, "to": to, "subject": subject, "bodyFile": "HANDOFF.md", "attachments": copied}, 0o644)
        return {"id": str(directory), "url": directory.as_uri(), "dir": str(directory)}

    def read_handoff(self, reference, destination_directory=None):
        directory = self.path(reference)
        if directory.is_file(): directory = directory.parent
        index = assert_format(read_json(directory / "handoff.json"), "handoff-local")
        read_dir = Path(destination_directory) if destination_directory else directory
        if destination_directory:
            read_dir.mkdir(parents=True, exist_ok=True)
            for name in (index["bodyFile"], "handoff.json", *[a["name"] for a in index["attachments"]]): copy_verified(directory / name, read_dir / name)
        return {"id": str(directory), "subject": index.get("subject"), "to": index.get("to"), "body": (read_dir / index["bodyFile"]).read_text(encoding="utf-8"), "attachments": {item["name"]: str(read_dir / item["name"]) for item in index["attachments"]}, "index": index}

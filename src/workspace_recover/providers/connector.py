"""Google resource operations delegated to the registered typed host bridge."""
from pathlib import Path
import re
from ..bridge import ConnectorBridge, require
from ..util import file_record, copy_verified, write_text, sha256_file
from .google_workspace import drive_id, gmail_message_id, ATTACHMENTS


def reference_id(reference): return (reference.get("id") or reference.get("url")) if isinstance(reference, dict) else reference


class ConnectorProvider:
    type = "google-workspace"
    def __init__(self, config):
        self.config, self.executor = config, config["executor"]
        require(config.get("sessionDir"), "connector provider requires a session directory")
        self.directory = Path(config["sessionDir"])
        self.bridge = ConnectorBridge(config.get("bridge"), config["sessionId"], mode=self.executor,
            wait_timeout_ms=config.get("waitTimeoutMs", 1800000), required_operations=config.get("requiredOperations", []),
            account=config.get("account"), on_pending=config.get("onPending"), on_resolved=config.get("onResolved"))
    def ready(self): return self.bridge.ready()

    def upload(self, file, name=None, folder_id=None):
        file = Path(file)
        artifact = {**file_record(file), "name": name or file.name}
        folder = drive_id(folder_id or self.config.get("folderId"))
        require(folder, "upload requires Drive folder ID")
        result = self.bridge.perform("drive.upload", {"artifact": artifact, "folderId": folder, "sharing": "preserve"})
        identifier = drive_id(result.get("id"))
        require(identifier, "upload response requires ID")
        require(result.get("parent") == folder or folder in result.get("parents", []), "uploaded object is not in requested folder")
        require(float(result.get("bytes", -1)) == artifact["bytes"], "upload response size mismatch")
        return {"id": identifier, "url": result.get("url"), "name": artifact["name"], "bytes": artifact["bytes"], "sha256": artifact["sha256"], "parent": folder}

    def metadata(self, reference):
        identifier = drive_id(reference_id(reference))
        result = self.bridge.perform("drive.metadata", {"id": identifier})
        require(result.get("id") == identifier, "metadata response ID mismatch")
        return result

    def download(self, reference, destination, expected_folder_id=None, expected_bytes=None, expected_sha256=None):
        identifier = drive_id(reference_id(reference))
        folder = drive_id(expected_folder_id) if expected_folder_id else None
        result = self.bridge.perform("drive.download", {"id": identifier, "expectedFolderId": folder, "expectedBytes": expected_bytes, "expectedSha256": expected_sha256})
        require(result.get("id") == identifier, "download response ID mismatch")
        if folder: require(result.get("parent") == folder or folder in result.get("parents", []), "download object outside requested folder")
        path = Path(result["path"])
        require(path.is_file() and not path.is_symlink(), "download response must identify a regular local file")
        if expected_bytes is not None: require(path.stat().st_size == expected_bytes, "download size mismatch")
        if expected_sha256 is not None: require(sha256_file(path) == expected_sha256, "download SHA256 mismatch")
        copy_verified(path, destination)
        return str(destination)

    def send_handoff(self, session_id, to, subject, body, attachments):
        directory = self.directory / "outgoing-mail"
        directory.mkdir(parents=True, exist_ok=True)
        body_file = directory / "body.txt"
        write_text(body_file, body)
        copied = []
        for item in attachments:
            require(item["name"] in ATTACHMENTS, "unsupported handoff attachment name")
            file = directory / item["name"]
            copy_verified(item["path"], file)
            copied.append({"name": item["name"], **file_record(file), "mimeType": item.get("mimeType")})
        result = self.bridge.perform("gmail.send", {"sessionId": session_id, "to": [x.strip() for x in to.split(",")] if isinstance(to, str) else to, "subject": subject, "contentType": "text/plain", "bodyFile": str(body_file), "bodySha256": sha256_file(body_file), "attachments": copied})
        return {**result, "id": gmail_message_id(result.get("id"))}

    def read_handoff(self, reference, destination_directory):
        identifier = gmail_message_id(reference)
        result = self.bridge.perform("gmail.read", {"id": identifier, "attachmentNames": list(ATTACHMENTS)})
        require(result.get("id") == identifier, "Gmail readback ID mismatch")
        require(isinstance(result.get("subject"), str) and isinstance(result.get("body"), str) and isinstance(result.get("to"), list), "Gmail readback requires subject, body and recipients")
        require(isinstance(result.get("attachments"), list), "Gmail response attachments must be an array")
        directory, attachments = Path(destination_directory), {}
        directory.mkdir(parents=True, exist_ok=True)
        for item in result["attachments"]:
            name = item.get("name")
            require(isinstance(name, str) and not re.search(r"[\\/\0]", name), "unsafe attachment name")
            if name not in ATTACHMENTS: continue
            require(name not in attachments, "duplicate handoff attachment")
            source = Path(item["path"])
            require(source.is_file() and not source.is_symlink(), "attachment must be a regular local file")
            target = directory / name
            copy_verified(source, target)
            attachments[name] = str(target)
        return {"id": identifier, "body": result["body"], "subject": result["subject"], "to": result["to"], "attachments": attachments, "providerAttestation": "host-connector"}

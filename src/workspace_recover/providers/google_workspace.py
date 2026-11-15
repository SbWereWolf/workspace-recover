"""Explicit OAuth/Drive/Gmail transport using Python standard-library HTTP."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from command_execution.commands import prepare_invocation
from command_execution.processes import execute_invocation
from ..profiles import profile_name
from ..util import home_dir, read_json, write_json, write_text, now_iso, sha256_file

SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]
ATTACHMENTS = ("workspace-handoff.json", "workspace-recovery-manifest.json", "workspace-transport-manifest.json", "workspace-backup-receipt.json", "workspace-rehearsal-receipt.json")


def profile_dir(profile="default"): return home_dir("config") / "google-workspace" / profile_name(profile)


def auth_status(profile="default"):
    directory = profile_dir(profile)
    return {"profile": profile, "clientPath": str(directory / "client.json"), "tokenPath": str(directory / "token.json"), "clientPresent": (directory / "client.json").exists(), "tokenPresent": (directory / "token.json").exists()}


def client_values(document):
    value = document.get("installed") or document.get("web") or document
    if not value.get("client_id") or not value.get("client_secret"): raise ValueError("Google OAuth client JSON must contain client_id and client_secret")
    return value["client_id"], value["client_secret"]


class AuthRequired(ValueError):
    code = "AUTH_REQUIRED"
    def __init__(self, message, profile):
        super().__init__(message)
        self.auth_command = f"workspace-recover auth google-workspace --profile {profile}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise urllib.error.HTTPError(request.full_url, code, "redirect is not allowed", headers, fp)


def request(url, *, method="GET", headers=None, data=None, timeout=120):
    selected = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    return urllib.request.build_opener(NoRedirect()).open(selected, timeout=timeout)


def form_post(url, fields):
    with request(url, method="POST", headers={"content-type": "application/x-www-form-urlencoded"}, data=urllib.parse.urlencode(fields).encode()) as response:
        return json.load(response)


def b64url(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text): return base64.urlsafe_b64decode(text + "=" * ((-len(text)) % 4))


def authorize(client_file=None, profile="default", *, scopes=None, no_browser=False, timeout_ms=300000):
    scopes = scopes or SCOPES
    directory = profile_dir(profile)
    directory.mkdir(parents=True, exist_ok=True)
    if client_file:
        document = read_json(client_file)
        client_values(document)
        write_json(directory / "client.json", document)
    if not (directory / "client.json").exists(): raise ValueError(f"Google OAuth client credentials missing: {directory / 'client.json'}")
    client_id, client_secret = client_values(read_json(directory / "client.json"))
    state, verifier = secrets.token_hex(24), secrets.token_urlsafe(32)
    result = {}
    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/oauth2/callback":
                self.send_error(404, "Not found")
                return
            values = urllib.parse.parse_qs(parsed.query)
            try:
                if values.get("state", [None])[0] != state: raise ValueError("OAuth state mismatch")
                if values.get("error"): raise ValueError("Google authorization failed: " + values["error"][0])
                code = values.get("code", [None])[0]
                if not code: raise ValueError("OAuth callback did not contain an authorization code")
                result["code"] = code
                self.send_response(200)
                self.send_header("content-type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"workspace-recover authorization received. You can close this browser tab.")
            except Exception as error:
                result["error"] = error
                self.send_error(400, str(error))
    with http.server.HTTPServer(("127.0.0.1", 0), Callback) as server:
        redirect = f"http://127.0.0.1:{server.server_port}/oauth2/callback"
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({"client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": " ".join(scopes), "access_type": "offline", "prompt": "consent", "state": state, "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256"})
        print("Open this URL to authorize Google Workspace:\n" + url)
        if not no_browser:
            import sys
            executable = "open" if sys.platform == "darwin" else "xdg-open"
            invocation = prepare_invocation({"argv": [executable, url]}, base_dir=str(Path.cwd()))
            execute_invocation(invocation, {"mode": "detached", "environment": "inherit", "session": "new", "stdout": {"kind": "discard"}, "stderr": {"kind": "discard"}, "timeout": None})
        deadline = time.monotonic() + timeout_ms / 1000
        while not result and time.monotonic() < deadline:
            server.timeout = min(1, max(0, deadline - time.monotonic()))
            server.handle_request()
    if not result: raise ValueError("OAuth callback timed out; authorize again")
    if result.get("error"): raise result["error"]
    try: token = form_post("https://oauth2.googleapis.com/token", {"code_verifier": verifier, "code": result["code"], "client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect, "grant_type": "authorization_code"})
    except urllib.error.HTTPError as error: raise ValueError(f"Google token exchange failed: HTTP {error.code}") from error
    if not token.get("refresh_token"): raise ValueError("Google did not return a refresh token; revoke prior app access and authorize again with consent")
    token.update(obtained_at=now_iso(), expires_at=time.time() * 1000 + float(token.get("expires_in", 3600)) * 1000, scopes=scopes)
    write_json(directory / "token.json", token)
    return {"profile": profile, "tokenPath": str(directory / "token.json"), "scopes": scopes}


def access_token(profile):
    directory = profile_dir(profile)
    if not (directory / "client.json").exists() or not (directory / "token.json").exists(): raise AuthRequired(f"Google Workspace authorization is required for profile {profile}", profile)
    client_id, client_secret = client_values(read_json(directory / "client.json"))
    token = read_json(directory / "token.json")
    if token.get("access_token") and float(token.get("expires_at", 0)) > time.time() * 1000 + 60000: return token["access_token"]
    if not token.get("refresh_token"): raise ValueError(f"Google refresh token missing: {directory / 'token.json'}")
    try: refreshed = form_post("https://oauth2.googleapis.com/token", {"client_id": client_id, "client_secret": client_secret, "refresh_token": token["refresh_token"], "grant_type": "refresh_token"})
    except urllib.error.HTTPError as error:
        try: detail = json.loads(error.read()).get("error", "unknown_error")
        except Exception: detail = "unknown_error"
        message = f"Google token refresh failed: HTTP {error.code}; {detail}"
        if detail == "invalid_grant": raise AuthRequired(message, profile) from error
        raise ValueError(message) from error
    updated = {**token, **refreshed, "refresh_token": token["refresh_token"], "expires_at": time.time() * 1000 + float(refreshed.get("expires_in", 3600)) * 1000, "refreshed_at": now_iso()}
    write_json(directory / "token.json", updated)
    if not isinstance(updated.get("access_token"), str) or not updated["access_token"]: raise ValueError("Google refresh response has no access token")
    return updated["access_token"]


def google_fetch(profile, url, **options):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("www.googleapis.com", "gmail.googleapis.com") or parsed.username or parsed.password: raise ValueError("unexpected Google API endpoint")
    headers = {**options.pop("headers", {}), "authorization": "Bearer " + access_token(profile)}
    try: return request(url, headers=headers, **options)
    except urllib.error.HTTPError as error:
        message = f"Google API request failed: HTTP {error.code}"
        if error.code == 401: raise AuthRequired(message, profile) from error
        raise ValueError(message) from error


def drive_id(value):
    if value is None or value == "": return None
    if not isinstance(value, str): raise ValueError("invalid Google Drive ID")
    if re.fullmatch(r"[A-Za-z0-9_-]+", value): return value
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "drive.google.com" or parsed.username or parsed.password: raise ValueError("invalid Google Drive URL host")
    match = re.search(r"/folders/([A-Za-z0-9_-]+)/?$|/file/d/([A-Za-z0-9_-]+)(?:/view)?/?$", parsed.path)
    if not match: raise ValueError("invalid Google Drive URL path")
    return match.group(1) or match.group(2)


def gmail_message_id(value):
    if not isinstance(value, str): raise ValueError("invalid Gmail message ID")
    if re.fullmatch(r"[a-fA-F0-9]{12,40}", value): return value
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "mail.google.com" or parsed.username or parsed.password: raise ValueError("invalid Gmail message URL host")
    identifier = parsed.fragment.split("/")[-1]
    if not re.fullmatch(r"[a-fA-F0-9]{12,40}", identifier): raise ValueError("Gmail URL requires a hexadecimal API message ID; opaque UI-only identifiers are not API IDs")
    return identifier


def make_raw_email(to, subject, body, attachments):
    for value in (to, subject):
        if not isinstance(value, str) or re.search(r"[\r\n\0]", value): raise ValueError("unsafe MIME header")
    for item in attachments:
        if not isinstance(item.get("name"), str) or not item["name"] or re.search(r'[\r\n\0\\/\"]', item["name"]): raise ValueError("unsafe attachment filename")
    encoded_subject = "=?UTF-8?B?" + base64.b64encode(subject.encode()).decode() + "?=" if re.search(r"[^\x20-\x7e]", subject) else subject
    boundary = "wr_" + secrets.token_hex(12)
    lines = ["To: " + to, "Subject: " + encoded_subject, "MIME-Version: 1.0", f'Content-Type: multipart/mixed; boundary="{boundary}"', "", "--" + boundary, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", body]
    for item in attachments:
        encoded = base64.b64encode(Path(item["path"]).read_bytes()).decode()
        lines.extend(["--" + boundary, f"Content-Type: {item.get('mimeType', 'application/octet-stream')}; name=\"{item['name']}\"", "Content-Transfer-Encoding: base64", f"Content-Disposition: attachment; filename=\"{item['name']}\"", "", "\r\n".join(encoded[i:i + 76] for i in range(0, len(encoded), 76))])
    lines.extend(["--" + boundary + "--", ""])
    return b64url("\r\n".join(lines).encode("utf-8"))


class GoogleWorkspaceProvider:
    type = "google-workspace"
    def __init__(self, profile="default", drive_folder_id=None): self.profile, self.drive_folder_id = profile_name(profile), drive_id(drive_folder_id)
    def ready(self):
        access_token(self.profile)
        return {"ready": True}

    def upload(self, file, name=None, folder_id=None):
        file, folder = Path(file), drive_id(folder_id or self.drive_folder_id)
        if not folder: raise ValueError("Google Drive folder ID is required for upload")
        size = file.stat().st_size
        with google_fetch(self.profile, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink,parents", method="POST", headers={"content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/octet-stream", "x-upload-content-length": str(size)}, data=json.dumps({"name": name or file.name, "parents": [folder]}).encode()) as start:
            location = start.headers.get("location")
        if not location: raise ValueError("Google Drive resumable upload did not return a Location header")
        endpoint = urllib.parse.urlparse(location)
        if endpoint.scheme != "https" or endpoint.hostname != "www.googleapis.com" or endpoint.username or endpoint.password or not endpoint.path.startswith("/upload/drive/v3/files"): raise ValueError("unexpected Google upload endpoint URL")
        with file.open("rb") as stream:
            with google_fetch(self.profile, location, method="PUT", headers={"content-type": "application/octet-stream", "content-length": str(size)}, data=stream) as response: value = json.load(response)
        if not value.get("id"): raise ValueError("Google Drive upload has no file ID")
        drive_id(value["id"])
        return {"id": value["id"], "name": value.get("name", name or file.name), "bytes": int(value.get("size", size)), "url": value.get("webViewLink") or f"https://drive.google.com/file/d/{value['id']}/view", "parent": folder, "sha256": sha256_file(file)}

    def metadata(self, reference):
        identifier = drive_id((reference.get("id") or reference.get("url")) if isinstance(reference, dict) else reference)
        with google_fetch(self.profile, f"https://www.googleapis.com/drive/v3/files/{identifier}?fields=id,name,size,webViewLink,parents") as response: value = json.load(response)
        if not value.get("id"): raise ValueError("Google Drive upload has no file ID")
        drive_id(value["id"])
        parents = value.get("parents", [])
        return {"id": value["id"], "name": value.get("name"), "bytes": int(value.get("size", 0)), "url": value.get("webViewLink"), "parents": parents, "parent": parents[0] if parents else None}

    def download(self, reference, destination, expected_folder_id=None, **expected):
        identifier = drive_id((reference.get("id") or reference.get("url")) if isinstance(reference, dict) else reference)
        metadata = self.metadata(identifier)
        if expected_folder_id and drive_id(expected_folder_id) not in metadata["parents"]: raise ValueError(f"Drive file {identifier} is not in expected folder {drive_id(expected_folder_id)}")
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        with google_fetch(self.profile, f"https://www.googleapis.com/drive/v3/files/{identifier}?alt=media") as response:
            with target.open("wb") as out:
                while data := response.read(1024 * 1024): out.write(data)
        return str(target)

    def send_handoff(self, session_id, to, subject, body, attachments):
        raw = make_raw_email(to, subject, body, attachments)
        with google_fetch(self.profile, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", method="POST", headers={"content-type": "application/json"}, data=json.dumps({"raw": raw}).encode()) as response: value = json.load(response)
        return {"id": value["id"], "threadId": value.get("threadId"), "url": f"https://mail.google.com/mail/u/0/#all/{value['id']}"}

    def part_bytes(self, identifier, part):
        body = part.get("body", {})
        if body.get("data"): return unb64url(body["data"])
        if body.get("attachmentId"):
            with google_fetch(self.profile, f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{identifier}/attachments/{urllib.parse.quote(body['attachmentId'], safe='')}") as response: value = json.load(response)
            return unb64url(value.get("data", ""))
        return b""

    def read_handoff(self, reference, destination_directory):
        identifier = gmail_message_id(reference)
        with google_fetch(self.profile, f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{identifier}?format=full") as response: value = json.load(response)
        directory = Path(destination_directory)
        directory.mkdir(parents=True, exist_ok=True)
        attachments, body = {}, ""
        def flatten(part):
            yield part
            for item in part.get("parts", []): yield from flatten(item)
        for part in flatten(value["payload"]):
            name = part.get("filename", "")
            if name:
                if re.search(r"[\\/\0]", name) or name in (".", ".."): raise ValueError("unsafe handoff attachment name")
                if name not in ATTACHMENTS: continue
                if name in attachments: raise ValueError("duplicate handoff attachment")
                target = directory / name
                write_text(target, self.part_bytes(identifier, part))
                attachments[name] = str(target)
            elif not body and part.get("mimeType") == "text/plain": body = self.part_bytes(identifier, part).decode("utf-8", errors="replace")
        headers = {header["name"].lower(): header["value"] for header in value["payload"].get("headers", [])}
        return {"id": identifier, "body": body, "subject": headers.get("subject"), "to": headers.get("to"), "attachments": attachments, "raw": value}

"""Durable host request identities and explicit external-outcome boundaries."""
from pathlib import Path
import os
import re
import time
import uuid
from .invocation import prepare_invocation
from .processes import execute_invocation
from .formats import schema, assert_format
from .util import canonical, sha256_text, read_json, now_iso, exists
from .json_files import stringify

OPERATIONS = {"drive.upload", "drive.download", "drive.metadata", "gmail.send", "gmail.read"}


class ConnectorBoundary(Exception):
    def __init__(self, message, code, request=None):
        super().__init__(message)
        self.code, self.request = code, request


def require(condition, message):
    if not condition: raise ValueError(message)


def validate_capabilities(document):
    assert_format(document, "bridge-capabilities")
    require(isinstance(document.get("account"), str) and re.fullmatch(r"[^\s@]+@[^\s@]+", document["account"]), "bridge account is required")
    operations = document.get("operations")
    require(isinstance(operations, list) and bool(operations) and all(x in OPERATIONS for x in operations), "invalid bridge operations")
    if "dispatchCommand" in document:
        require(isinstance(document["dispatchCommand"], list) and bool(document["dispatchCommand"]) and all(isinstance(x, str) and x and "\0" not in x for x in document["dispatchCommand"]), "invalid dispatchCommand argv")
    return document


def exclusive_json(path, document, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(stringify(document, indent=2) + "\n")


def immutable(path, document):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    exclusive_json(temporary, document)
    try:
        try: os.link(temporary, path)
        except FileExistsError:
            require(canonical(read_json(path)) == canonical(document), f"conflicting immutable record: {path.name}")
    finally:
        temporary.unlink(missing_ok=True)


def initialize_bridge(root, capabilities):
    validate_capabilities(capabilities)
    root = Path(root).absolute()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(root.is_dir() and not root.is_symlink(), "bridge must be a real private directory")
    root.chmod(0o700)
    exclusive_json(root / "capabilities.json", capabilities)
    for name in ("requests", "responses", "resolutions"):
        (root / name).mkdir(mode=0o700)
    return {"schema": schema("bridge-location"), "root": str(root), "account": capabilities["account"]}


def request_file(root, identifier):
    require(isinstance(identifier, str) and re.fullmatch(r"rq_[a-f0-9]{64}", identifier), "invalid connector request ID")
    return Path(root) / "requests" / (identifier + ".json")


def effective_response(root, identifier):
    for name in ("resolutions", "responses"):
        path = Path(root) / name / (identifier + ".json")
        if exists(path): return read_json(path)
    return None


def pending_requests(root, session_id=None):
    directory = Path(root) / "requests"
    values = []
    for file in sorted(directory.glob("rq_*.json")):
        if not re.fullmatch(r"rq_[a-f0-9]{64}\.json", file.name): continue
        request = assert_format(read_json(file), "connector-request")
        if session_id and request["sessionId"] != session_id: continue
        if effective_response(root, request["requestId"]) is None: values.append(request)
    return {"schema": schema("connector-request-batch"), "requests": values}


def submit_results(root, document):
    assert_format(document, "connector-results")
    require(isinstance(document.get("results"), list) and bool(document["results"]), "results must be a nonempty batch")
    prepared, seen = [], set()
    for item in document["results"]:
        require(isinstance(item, dict), "invalid result request ID")
        file = request_file(root, item.get("requestId"))
        identifier = item["requestId"]
        require(identifier not in seen, "duplicate result request ID")
        seen.add(identifier)
        request = assert_format(read_json(file), "connector-request")
        require(item.get("sessionId") == request["sessionId"] and item.get("requestHash") == request["requestHash"], "connector response does not match frozen request/session")
        require(item.get("status") in ("completed", "failed", "unknown"), "invalid connector result status")
        if item["status"] == "completed": require(isinstance(item.get("result"), dict), "completed response requires result object")
        else: require(isinstance(item.get("error"), str) and bool(item["error"]), "failed/unknown response requires error")
        response = {"schema": schema("connector-response"), **item}
        previous = effective_response(root, identifier)
        directory, duplicate = "responses", False
        if previous:
            if canonical(previous) == canonical(response): duplicate = True
            else:
                require(previous["status"] == "unknown" and item.get("resolvesSha256") == sha256_text(canonical(previous)), "conflicting response; only an explicitly bound unknown outcome can be reconciled")
                require(item["status"] != "unknown", "reconciliation must resolve the outcome")
                directory = "resolutions"
        else: require(not item.get("resolvesSha256"), "unexpected reconciliation without prior unknown outcome")
        prepared.append((Path(root) / directory / (identifier + ".json"), response, duplicate))
    for path, response, duplicate in prepared:
        if not duplicate: immutable(path, response)
    return {"schema": schema("connector-results-receipt"), "accepted": [r["requestId"] for _, r, _ in prepared], "duplicates": sum(int(d) for _, _, d in prepared)}


class ConnectorBridge:
    def __init__(self, root, session_id, *, mode="connector", wait_timeout_ms=1800000,
                 on_pending=None, on_resolved=None, required_operations=(), account=None):
        require(isinstance(root, str) and bool(root), "connector bridge directory is required")
        require(bool(re.fullmatch(r"wr_[bri]_\d{14}_[a-f0-9]{12}", session_id)), "connector requires a real session ID")
        require(mode in ("connector", "delegated"), "invalid bridge mode")
        require(type(wait_timeout_ms) is int and wait_timeout_ms > 0, "bridge timeout must be positive")
        self.root, self.session_id = Path(root).absolute(), session_id
        self.mode, self.wait_timeout_ms, self.account = mode, wait_timeout_ms, account
        self.on_pending, self.on_resolved, self.required_operations = on_pending, on_resolved, required_operations
        self.capabilities = None

    def ready(self):
        if not (self.root / "capabilities.json").exists():
            raise ConnectorBoundary("Host connector bridge is not registered", "CAPABILITY_REQUIRED")
        require(self.root.is_dir() and not self.root.is_symlink(), "bridge must be a real directory")
        self.capabilities = validate_capabilities(read_json(self.root / "capabilities.json"))
        require(not self.account or self.account == self.capabilities["account"], "connector account does not match configured account")
        missing = [x for x in self.required_operations if x not in self.capabilities["operations"]]
        if missing: raise ConnectorBoundary("Missing host capabilities: " + ", ".join(missing), "CAPABILITY_REQUIRED")
        return {"ready": True, "executor": self.mode, "account": self.capabilities["account"]}

    def perform(self, operation, payload):
        if self.capabilities is None: self.ready()
        if operation not in self.capabilities["operations"]: raise ConnectorBoundary(f"Missing host capability: {operation}", "CAPABILITY_REQUIRED")
        identity = {"sessionId": self.session_id, "account": self.capabilities["account"], "operation": operation, "payload": payload}
        digest = sha256_text(canonical(identity))
        identifier = "rq_" + digest
        file = request_file(self.root, identifier)
        if exists(file):
            request = assert_format(read_json(file), "connector-request")
            require(request["requestHash"] == digest, "request fingerprint changed")
        else:
            request = {"schema": schema("connector-request"), **identity, "requestId": identifier, "requestHash": digest, "createdAt": now_iso()}
            immutable(file, request)
        answer = effective_response(self.root, identifier)
        if answer is None:
            if self.on_pending: self.on_pending(request, str(self.root))
            if self.mode == "delegated": raise ConnectorBoundary("External operation awaits the host agent", "EXTERNAL_PENDING", request)
            if self.capabilities.get("dispatchCommand"): self.dispatch(request, file)
            started = time.monotonic()
            while answer is None:
                answer = effective_response(self.root, identifier)
                if answer is not None: break
                if (time.monotonic() - started) * 1000 >= self.wait_timeout_ms:
                    raise ConnectorBoundary("Connector response timeout; pending request retained", "EXTERNAL_PENDING", request)
                time.sleep(0.1)
        assert_format(answer, "connector-response")
        require(answer["requestHash"] == digest and answer["sessionId"] == self.session_id, "response binding mismatch")
        if answer["status"] == "unknown": raise ConnectorBoundary("External outcome unknown: " + answer["error"], "EXTERNAL_OUTCOME_UNKNOWN", request)
        require(answer["status"] == "completed", f"Connector {operation} failed: {answer.get('error')}")
        if self.on_resolved: self.on_resolved(request, answer)
        return answer["result"]

    def dispatch(self, request, request_path):
        result_path = self.root / (request["requestId"] + ".dispatcher-results.json")
        claim = self.root / (request["requestId"] + ".dispatch-started.json")
        if exists(claim): raise ConnectorBoundary("Dispatcher was already started; reconcile its outcome instead of replaying", "EXTERNAL_OUTCOME_UNKNOWN", request)
        immutable(claim, {"schema": schema("connector-dispatch-claim"), "requestId": request["requestId"], "startedAt": now_iso()})
        invocation = prepare_invocation({"argv": self.capabilities["dispatchCommand"] + [str(request_path), str(result_path)], "cwd": str(Path.cwd()), "env": {}}, base_dir=str(Path.cwd()))
        result = execute_invocation(invocation, {"mode": "foreground", "environment": "inherit", "session": "inherit",
            "stdout": {"kind": "discard"}, "stderr": {"kind": "bytes"},
            "timeout": {"milliseconds": self.wait_timeout_ms, "scope": "child", "firstSignal": "SIGKILL"}})
        if result["kind"] != "finished" or result["exit_code"] != 0 or not result_path.exists():
            error = "Host dispatcher outcome is unknown: " + (result.get("stderr", b"").decode("utf-8", errors="replace")[-8192:] or "no successful results file")
            submit_results(self.root, {"schema": schema("connector-results"), "results": [{"requestId": request["requestId"], "requestHash": request["requestHash"], "sessionId": self.session_id, "status": "unknown", "error": error}]})
            raise ConnectorBoundary(error, "EXTERNAL_OUTCOME_UNKNOWN", request)
        submit_results(self.root, read_json(result_path))

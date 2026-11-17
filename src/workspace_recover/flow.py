"""Caller-owned current-stage flow state machine; CE owns generic execution."""
from copy import deepcopy
from pathlib import Path
import errno
import math
import os
import shlex
import shutil
import socket
import stat
import tempfile
import time
import uuid
from .invocation import prepare_invocation
from .processes import execute_invocation
from .util import read_json, write_json, write_text, now_iso, session_id, canonical, sha256_text, sha256_file, file_record, exists, render
from .bridge import ConnectorBridge, ConnectorBoundary, exclusive_json, submit_results, effective_response

SCHEMA, STATE = "workspace-recover/flow/v3", "workspace-recover/flow-state/v3"
TERMINAL = {"COMPLETED", "COMPLETED_WITH_OBSERVATIONS", "STOPPED"}
OPS = {"mkdir", "tempdir", "input", "copy", "move", "archive", "extract", "command", "verification", "hash", "write", "host"}


def digest(value): return sha256_text(canonical(value))


def observation(code, message, **extra): return {"code": code, "message": message, **extra}


class Choice(Exception):
    def __init__(self, code, message, options=(), **details):
        super().__init__(message)
        self.code, self.options, self.details = code, list(dict.fromkeys([*options, "retry", "skip", "replace-step", "stop"])), details


def validate_flow(flow):
    import re
    if not isinstance(flow, dict) or flow.get("schema") != SCHEMA or not isinstance(flow.get("steps"), list):
        raise ValueError("Expected a flow manifest with a steps array.")
    seen = set()
    for step in flow["steps"]:
        if not isinstance(step, dict) or not isinstance(step.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", step["id"]) or step["id"] in seen:
            raise ValueError("Step IDs must be unique plain identifiers.")
        seen.add(step["id"])
        if step.get("op") not in OPS: raise ValueError(f"Unsupported operation: {step.get('op')}")
        if "onError" in step and step["onError"] not in ("continue", "ask", "stop"): raise ValueError("Unknown onError behavior.")
        if "existingTarget" in step and step["existingTarget"] not in ("merge", "overwrite", "new-directory", "skip", "ask"): raise ValueError("Unknown existingTarget choice.")
        retry = step.get("retry")
        if "retry" in step:
            maximum = retry.get("maxAttempts") if isinstance(retry, dict) else None
            if type(maximum) not in (int, float) or not math.isfinite(maximum) or maximum < 1 or maximum % 1 != 0 or not isinstance(retry.get("delayMs"), (int, float)) or retry["delayMs"] < 0:
                raise ValueError("retry needs maxAttempts >= 1 and delayMs >= 0.")
    return flow


def context(state):
    return {"workspace": state["workspace"], "session": state["directory"], "variables": state["variables"], "outputs": state["outputs"], "env": dict(os.environ)}


def local(state, value):
    if not isinstance(value, str) or not value or "\0" in value: raise ValueError("A nonempty path is needed for this operation.")
    return Path(os.path.abspath(os.path.join(state["workspace"], value)))


def persist(state):
    state["updatedAt"] = now_iso()
    write_json(Path(state["directory"]) / "state.json", state)
    write_json(Path(state["directory"]) / "next-actions.json", view(state))


def cli_argv(*args):
    import sys
    return [sys.executable, "-P", "-s", "-B", "-m", "workspace_recover", "flow", *map(str, args)]


def view(state):
    steps = state["manifest"]["steps"]
    cursor = state["cursor"]
    pending = state.get("pending")
    run = cli_argv("run", "--session", state["directory"])
    instruction = "No user question is needed. Execute the declared work or the host request."
    if pending:
        instruction = ("The current question has already been shown. Await its answer without repeating it." if pending.get("presented") else "Ask only about this current-stage request, then record it with flow presented. Resume the remaining manifest without confirmations.")
    ubuntu = shlex.join(run)
    if state.get("notBefore"):
        import math
        ubuntu = f"sleep {max(0, math.ceil((state['notBefore'] - time.time() * 1000) / 1000))}; " + ubuntu
    return {"schema": "workspace-recover/flow-status/v3", "sessionId": state["sessionId"], "status": state["status"],
        "currentStep": steps[cursor]["id"] if cursor < len(steps) else None, "completedSteps": cursor, "totalSteps": len(steps),
        "decisionRequest": pending, "questionNeeded": bool(pending and not pending.get("presented")),
        "hostRequest": state.get("hostRequest"), "notBefore": state.get("notBefore"), "observations": state["observations"],
        "results": state["results"], "next": None if state["status"] in TERMINAL else {"argv": run, "ubuntu": ubuntu}, "instruction": instruction}


def with_lock(directory, function):
    directory = Path(directory).absolute()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / "run.lock"
    try:
        exclusive_json(lock, {"pid": os.getpid(), "hostname": socket.gethostname(), "createdAt": now_iso()})
    except FileExistsError:
        try: owner = read_json(lock)
        except Exception: owner = None
        if isinstance(owner, dict) and owner.get("hostname") == socket.gethostname() and type(owner.get("pid")) is int:
            try: os.kill(owner["pid"], 0)
            except ProcessLookupError:
                lock.rename(str(lock) + ".stale-" + uuid.uuid4().hex)
                return with_lock(directory, function)
            except PermissionError: pass
        return {"status": "BUSY", "decisionRequest": None, "owner": owner, "instruction": "An active executor owns this session. Retry later; do not ask the user to confirm a known stage."}
    try: return function()
    finally: lock.unlink(missing_ok=True)


def init_state(directory, manifest=None, manifest_path=None, workspace=None, bridge=None):
    file = directory / "state.json"
    if file.exists():
        state = read_json(file)
        if state.get("schema") != STATE: raise ValueError("Unsupported saved flow state.")
        if state["directory"] != str(directory): raise ValueError("State was moved. Start a new flow session or explicitly repair its location.")
        if manifest is not None and digest(manifest) != state["manifestHash"] and not any(x["code"] == "SUPPLIED_MANIFEST_DIFFERS" for x in state["observations"]):
            state["observations"].append(observation("SUPPLIED_MANIFEST_DIFFERS", "Continuing the saved manifest. Use a step-scoped decision to change the current stage, or another session for a new plan."))
        return state
    validate_flow(manifest)
    workspace = Path(workspace or manifest.get("workspace") or tempfile.mkdtemp(prefix="workspace-recover-flow-")).absolute()
    workspace.mkdir(parents=True, exist_ok=True)
    return {"schema": STATE, "sessionId": session_id("wr_r"), "directory": str(directory), "workspace": str(workspace),
        "manifest": deepcopy(manifest), "manifestPath": str(manifest_path) if manifest_path else None, "manifestHash": digest(manifest),
        "variables": deepcopy(manifest.get("variables", {})), "outputs": {}, "cursor": 0, "results": [], "attempts": {}, "attemptHistory": [],
        "decisions": [], "overrides": {}, "observations": [], "bridge": bridge or manifest.get("bridge"), "status": "RUNNING",
        "pending": None, "inflight": None, "hostRequest": None, "notBefore": None}


def effective_step(state):
    original = state["manifest"]["steps"][state["cursor"]]
    return {**original, **state["overrides"].get(original["id"], {}), "id": original["id"]}


def save_choice(state, step, error):
    identity = {"sessionId": state["sessionId"], "index": state["cursor"], "stepId": step["id"], "code": error.code, "details": error.details}
    identifier = "decision_" + digest(identity)
    prefix = cli_argv("decide", "--session", state["directory"], "--request", identifier)
    options = []
    for choice in error.options:
        item = {"choice": choice, "argv": prefix + ["--choice", choice], "ubuntu": shlex.join(prefix + ["--choice", choice])}
        if choice == "replace-step": item["paramsTemplate"] = {"step": {"id": step["id"], "op": "command", "argv": ["bash", "-lc", "YOUR_COMMAND"]}}
        if choice in ("use-source", "new-directory"): item["paramsTemplate"] = {"path": "/absolute/source" if choice == "use-source" else "/absolute/new-directory"}
        options.append(item)
    state["pending"] = {"schema": "workspace-recover/decision-request/v3", "requestId": identifier, "scope": "current-step", "stepId": step["id"],
        "index": state["cursor"], "observation": {"code": error.code, "message": str(error), **error.details},
        "recommendations": [{"text": step.get("hint", "Inspect this stage, then choose how this stage should proceed."), "ubuntu": "cat -- " + shlex.quote(str(Path(state["directory"]) / "state.json"))}],
        "options": options, "note": "The answer applies to this stage only. It never becomes a global default."}
    state["status"] = "WAITING_DECISION"
    persist(state)
    return view(state)


def complete(state, step, result):
    entry = {"id": step["id"], "op": step["op"], "attempt": state["attempts"][step["id"]], **result, "stepId": step["id"], "finishedAt": now_iso()}
    state["results"].append(entry)
    state["outputs"][step["id"]] = deepcopy(entry)
    if step.get("saveAs"): state["variables"][step["saveAs"]] = entry.get("path", deepcopy(entry))
    state["observations"].extend(result.get("observations", []))
    if result["status"] == "failed":
        detail = {"stepId": step["id"]}
        for key in ("error", "exitCode"):
            if key in result: detail[key] = result[key]
        if result.get("stderr"): detail["ubuntu"] = "cat -- " + shlex.quote(result["stderr"])
        state["observations"].append(observation("STEP_FAILED", "The operation failed; this fact does not prohibit following stages.", **detail))
    state["cursor"] += 1
    for key in ("inflight", "pending", "hostRequest", "notBefore", "pendingResult", "preparedHost"): state[key] = None
    state["overrides"].pop(step["id"], None)


def destination(state, step, target):
    if not exists(target): return target, "new"
    policy = step.get("existingTarget")
    if not policy or policy == "ask": raise Choice("TARGET_EXISTS", f"Destination exists: {target}", ("merge", "overwrite", "new-directory"), path=str(target))
    if policy == "new-directory": return Path(tempfile.mkdtemp(prefix=target.name + "-", dir=target.parent)), "new-empty"
    return target, policy


def source(state, step, target, directory=False):
    if exists(target): return target
    if step.get("missingSource") == "skip": return None
    if step.get("missingSource") == "create-empty" and directory:
        target.mkdir(parents=True, exist_ok=True)
        return target
    raise Choice("SOURCE_MISSING", f"Input is not present at this stage: {target}", ("use-source", *(["create-empty"] if directory else [])), path=str(target),
                 ubuntu=("mkdir -p -- " + shlex.quote(str(target)) if directory else "ls -la -- " + shlex.quote(str(target.parent))))


def check_hash(file, expected=None):
    expected = expected or {}
    value, warnings = file_record(file), []
    for field, code, message in (("sha256", "HASH_MISMATCH", "Observed bytes do not match the declared hash."), ("bytes", "SIZE_MISMATCH", "Observed size differs from the declaration.")):
        if field in expected and expected[field] != value[field]: warnings.append(observation(code, message, expected=expected[field], actual=value[field], path=value["path"], ubuntu="sha256sum -- " + shlex.quote(str(file))))
    return {**value, "checks": "mismatch" if warnings else "matched" if expected else "not-requested", "observations": warnings}


def merge_copy(src, target, *, move=False, replace=False):
    if src.is_dir() and not src.is_symlink():
        if exists(target) and not target.is_dir():
            if not replace: raise ValueError(f"Cannot merge directory over non-directory: {target}")
            target.rename(str(target) + ".previous-" + uuid.uuid4().hex)
        target.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir(): merge_copy(child, target / child.name, move=move, replace=replace)
        if move: src.rmdir()
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        if exists(target): target.rename(str(target) + ".previous-" + uuid.uuid4().hex)
        if src.is_symlink(): target.symlink_to(os.readlink(src))
        else:
            with target.open("xb") as out, src.open("rb") as stream:
                shutil.copyfileobj(stream, out)
                out.flush()
                os.fchmod(out.fileno(), stat.S_IMODE(os.fstat(stream.fileno()).st_mode))
        if move: src.unlink()


def execute_command(state, step):
    invocation = prepare_invocation(step, base_dir=state["workspace"], profile="resolved")
    directory = Path(state["directory"]) / "logs" / f"{state['cursor']}-{step['id']}-{state['attempts'][step['id']]}"
    directory.mkdir(parents=True, exist_ok=True)
    out, err = directory / "stdout.log", directory / "stderr.log"
    timeout = None
    if step.get("timeoutMs", 0) > 0:
        timeout = {"milliseconds": step["timeoutMs"], "scope": "group", "firstSignal": "SIGTERM", "escalation": {"signal": "SIGKILL", "delayMs": 250}}
    result = execute_invocation(invocation, {"mode": "foreground", "environment": "inherit", "session": "new", "timeout": timeout,
        "stdout": {"kind": "file", "path": str(out), "mode": "truncate", "new_file_mode": 0o600}, "stderr": {"kind": "file", "path": str(err), "mode": "truncate", "new_file_mode": 0o600}})
    value = {"exitCode": result["exit_code"], "timedOut": result["timed_out"], "status": "passed" if result["kind"] == "finished" and result["exit_code"] == 0 and not result["timed_out"] else "failed",
             "durationMs": result["duration_ms"], "stdout": str(out), "stderr": str(err), "argv": invocation["argv"]}
    if result["kind"] == "launch_failed": value.update(error=result["launch_error"]["message"], errorCode=result["launch_error"]["os_code"])
    elif result["signal"]: value["signal"] = result["signal"]["name"]
    else: value["signal"] = None
    return value


def host(state, step):
    if not state.get("bridge"): raise Choice("HOST_BRIDGE_UNAVAILABLE", "An authorized host bridge is not configured.", ("replace-step",))
    def pending(request, _root):
        state["hostRequest"] = request
        persist(state)
    bridge = ConnectorBridge(state["bridge"], state["sessionId"], mode="delegated", required_operations=[step["operation"]], on_pending=pending)
    prepared = state.get("preparedHost")
    if prepared and prepared["stepId"] == step["id"] and prepared["attempt"] == state["attempts"][step["id"]]: payload = deepcopy(prepared["payload"])
    else:
        payload = deepcopy(step.get("payload", {}))
        directory = Path(state["directory"]) / "outgoing" / step["id"] / str(state["attempts"][step["id"]])
        if step["operation"] == "drive.upload":
            file = local(state, payload["file"])
            directory.mkdir(parents=True, exist_ok=True)
            snapshot = directory / "payload"
            with snapshot.open("xb") as out, file.open("rb") as stream: shutil.copyfileobj(stream, out)
            payload = {"artifact": {**file_record(snapshot), "name": payload.get("name", file.name), "mimeType": payload.get("mimeType", "application/octet-stream")}, "sharing": "preserve", **({"folderId": payload["folderId"]} if "folderId" in payload else {})}
        elif step["operation"] == "gmail.send":
            body = local(state, payload["bodyFile"]).read_text() if payload.get("bodyFile") else payload.get("body", "")
            directory.mkdir(parents=True, exist_ok=True)
            body_file = directory / "body.txt"
            with body_file.open("x", encoding="utf-8") as out: out.write(body)
            body_file.chmod(0o600)
            attachments = []
            for index, item in enumerate(payload.get("attachments", [])):
                file = local(state, item if isinstance(item, str) else item["path"])
                name = file.name if isinstance(item, str) else item.get("name", file.name)
                if Path(name).name != name or name in ("", ".", ".."): raise ValueError("Attachment name must be a basename.")
                target = directory / "attachments" / str(index) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as out, file.open("rb") as stream: shutil.copyfileobj(stream, out)
                attachments.append({**file_record(target), "name": name, "mimeType": "application/octet-stream" if isinstance(item, str) else item.get("mimeType", "application/octet-stream")})
            payload = {"to": payload["to"] if isinstance(payload["to"], list) else [payload["to"]], "subject": payload.get("subject"), "bodyFile": str(body_file), "bodySha256": sha256_file(body_file), "attachments": attachments, "contentType": "text/plain"}
        payload.update(flowStepId=step["id"], flowAttempt=state["attempts"][step["id"]])
        state["preparedHost"] = {"stepId": step["id"], "attempt": state["attempts"][step["id"]], "payload": deepcopy(payload)}
        persist(state)
    records = [payload.get("artifact"), *payload.get("attachments", [])]
    if payload.get("bodyFile"): records.append({"path": payload["bodyFile"], "sha256": payload.get("bodySha256")})
    for record in filter(None, records):
        if record.get("path") and (not exists(record["path"]) or sha256_file(record["path"]) != record.get("sha256")):
            raise Choice("PREPARED_HOST_BYTES_CHANGED", "The frozen outgoing bytes changed. Choose how this current stage should proceed.", path=record["path"])
    account = read_json(Path(state["bridge"]) / "capabilities.json")["account"]
    identifier = "rq_" + digest({"sessionId": state["sessionId"], "account": account, "operation": step["operation"], "payload": payload})
    claim = Path(state["directory"]) / "host-claims" / (identifier + ".json")
    if claim.exists() and effective_response(state["bridge"], identifier) is None:
        request = read_json(Path(state["bridge"]) / "requests" / (identifier + ".json"))
        raise ConnectorBoundary("Claimed host operation awaits actual response or reconciliation.", "EXTERNAL_PENDING", request)
    return {"status": "passed", **bridge.perform(step["operation"], payload)}


def execute(state, step):
    op = step["op"]
    if op == "mkdir":
        target = local(state, step.get("path") or step.get("to"))
        target.mkdir(parents=True, exist_ok=True)
        return {"status": "passed", "path": str(target)}
    if op == "tempdir":
        if step.get("path"):
            target = local(state, step["path"])
            target.mkdir(parents=True, exist_ok=True)
        else:
            parent = local(state, step["parent"]) if step.get("parent") else Path(tempfile.gettempdir())
            parent.mkdir(parents=True, exist_ok=True)
            target = Path(tempfile.mkdtemp(prefix=step.get("prefix", "wr-artifacts-"), dir=parent))
        return {"status": "passed", "path": str(target), "lifecycle": "retained-until-caller-cleanup"}
    if op == "input":
        roots = step.get("search", [state["workspace"], str(Path(state.get("manifestPath") or state["directory"]).parent)])
        paths = [local(state, step["path"])] if step.get("path") else [Path(root).absolute() / name for root in roots for name in step.get("names", [])]
        candidates = [check_hash(p, step.get("expected")) for p in dict.fromkeys(paths) if p.is_file()]
        valid = [c for c in candidates if c["checks"] != "mismatch"]
        distinct = {c["sha256"] for c in valid}
        if len(distinct) == 1:
            selected = valid[0]
            if len(candidates) > len(valid): selected["observations"].append(observation("OTHER_CANDIDATES_DIFFER", "The declaration identifies one byte sequence; other candidates were not selected."))
            return {"status": "passed", **selected}
        if len(distinct) > 1: raise Choice("INPUT_AMBIGUOUS", "Different input bytes are available and no declaration selects one.", ("use-source",), candidates=candidates)
        if len(candidates) == 1 and step.get("onMismatch") == "continue": return {"status": "passed", **candidates[0]}
        if not candidates and step.get("remote"): return host(state, {**step, "operation": "drive.download", "payload": step["remote"]})
        if not candidates and step.get("missingSource") == "skip": return {"status": "skipped", "reason": "manifest"}
        raise Choice("INPUT_MISMATCH" if candidates else "INPUT_MISSING", "Choose the input for this stage only.", ("use-source", *(["use-observed"] if len(candidates) == 1 else [])), candidates=candidates, search=list(map(str, paths)))
    if op == "hash": return {"status": "passed", **check_hash(local(state, step["path"]), step.get("expected"))}
    if op in ("command", "verification"): return execute_command(state, step)
    if op == "host": return host(state, step)
    if op == "write":
        target, mode = destination(state, step, local(state, step.get("path") or step.get("to")))
        if mode == "skip": return {"status": "skipped", "path": str(target)}
        if mode == "new-empty": raise ValueError("new-directory is not a destination for a file write; supply another file path.")
        content = step.get("content")
        if isinstance(content, str): write_text(target, content, step.get("mode", 0o600))
        else: write_json(target, content, step.get("mode", 0o600))
        return {"status": "passed", **file_record(target)}
    if op in ("copy", "move"):
        src = source(state, step, local(state, step["from"]), step.get("sourceKind") == "directory")
        if src is None: return {"status": "skipped", "reason": "manifest"}
        target, mode = destination(state, step, local(state, step["to"]))
        if mode == "skip": return {"status": "skipped", "path": str(target)}
        src_real, dst_real = src.resolve(), target.resolve()
        if src_real == dst_real or src_real in dst_real.parents: raise ValueError("Source and destination overlap. Use a distinct destination.")
        target.parent.mkdir(parents=True, exist_ok=True)
        if mode == "overwrite" and exists(target):
            preserved = str(target) + ".previous-" + uuid.uuid4().hex
            target.rename(preserved)
            state["observations"].append(observation("PREVIOUS_TARGET_PRESERVED", "Replaced destination was retained.", path=preserved))
        if op == "move" and mode not in ("merge", "new-empty"):
            try: src.rename(target)
            except OSError as error:
                if error.errno != errno.EXDEV: raise
                merge_copy(src, target, move=True, replace=True)
        else: merge_copy(src, target, move=op == "move", replace=mode == "overwrite")
        return {"status": "passed", "path": str(target), "source": str(src)}
    if op == "archive":
        from .archive import create_tar_gz
        src = source(state, step, local(state, step["from"]), True)
        if src is None: return {"status": "skipped", "reason": "manifest"}
        output = local(state, step["to"])
        if output == src or src in output.parents: raise ValueError("Archive output is inside its own source. Choose an external output path.")
        target, mode = destination(state, step, output)
        if mode == "skip": return {"status": "skipped", "path": str(target)}
        if mode == "new-empty": raise ValueError("Archive output needs a file path, not a directory.")
        temporary = Path(str(target) + ".packing-" + uuid.uuid4().hex)
        result = create_tar_gz(src, temporary, includes=step.get("include", ["**"]), excludes=step.get("exclude", []))
        temporary.rename(target)
        return {"status": "passed", **result, "output": str(target), "path": str(target)}
    if op == "extract":
        from .archive import extract_tar_gz
        src = source(state, step, local(state, step["from"]))
        if src is None: return {"status": "skipped", "reason": "manifest"}
        target, mode = destination(state, step, local(state, step["to"]))
        if mode == "skip": return {"status": "skipped", "path": str(target)}
        if mode == "overwrite" and exists(target):
            preserved = str(target) + ".previous-" + uuid.uuid4().hex
            target.rename(preserved)
            state["observations"].append(observation("PREVIOUS_TARGET_PRESERVED", "Replaced destination was retained.", path=preserved))
        extract_tar_gz(src, target, reject_existing=mode not in ("merge", "new-empty"))
        return {"status": "passed", "path": str(target), "archive": str(src)}
    raise ValueError(f"Unsupported action: {op}")


def drive(state, limit=float("inf")):
    if state["status"] in TERMINAL or state.get("pending"): return view(state)
    if state.get("notBefore") and time.time() * 1000 < state["notBefore"]: return view(state)
    if state.get("inflight") and state["status"] not in ("WAITING_HOST", "WAITING_RETRY"):
        return save_choice(state, effective_step(state), Choice("INTERRUPTED_OPERATION", "The prior executor stopped inside this stage; its effects may already exist.", ("mark-completed",), inflight=state["inflight"]))
    done = 0
    while state["cursor"] < len(state["manifest"]["steps"]) and done < limit:
        step = effective_step(state)
        if state["status"] != "WAITING_HOST": state["attempts"][step["id"]] = state["attempts"].get(step["id"], 0) + 1
        state.update(status="RUNNING", notBefore=None, inflight={"stepId": step["id"], "attempt": state["attempts"][step["id"]], "startedAt": now_iso()})
        persist(state)
        try:
            step = render(step, context(state), "wr-flow")
            result = execute(state, step)
        except Choice as error:
            state["inflight"] = None
            return save_choice(state, step, error)
        except ConnectorBoundary as error:
            if error.code == "EXTERNAL_PENDING":
                state.update(status="WAITING_HOST", hostRequest=error.request)
                persist(state)
                return view(state)
            if error.code == "EXTERNAL_OUTCOME_UNKNOWN":
                return save_choice(state, step, Choice("REMOTE_OUTCOME_UNKNOWN", str(error), ("mark-completed",), hostRequest=error.request))
            result = {"status": "failed", "error": str(error), "errorCode": error.code}
        except Exception as error:
            result = {"status": "failed", "error": str(error), "errorCode": errno.errorcode.get(getattr(error, "errno", None))}
        if result["status"] == "failed":
            retry = step.get("retry")
            if retry and state["attempts"][step["id"]] < retry["maxAttempts"]:
                state["attemptHistory"].append({"id": step["id"], "attempt": state["attempts"][step["id"]], **result})
                state.update(status="WAITING_RETRY", inflight=None, preparedHost=None, notBefore=time.time() * 1000 + retry["delayMs"])
                persist(state)
                return view(state)
            if step.get("onError") == "ask":
                state.update(pendingResult=result, inflight=None)
                return save_choice(state, step, Choice("COMMAND_FAILED" if "exitCode" in result else "OPERATION_FAILED", "The manifest delegates this failed stage to the caller.", ("continue",), **{k: result[k] for k in ("exitCode", "stderr") if k in result}))
        complete(state, step, result)
        done += 1
        if result["status"] == "failed" and step.get("onError") == "stop":
            state["status"] = "STOPPED"
            persist(state)
            return view(state)
        persist(state)
    state["status"] = ("COMPLETED_WITH_OBSERVATIONS" if state["observations"] else "COMPLETED") if state["cursor"] == len(state["manifest"]["steps"]) else "PAUSED"
    persist(state)
    return view(state)


def run_flow(directory, manifest=None, manifest_path=None, workspace=None, bridge=None, limit=float("inf")):
    directory = Path(os.path.abspath(directory))
    if limit != float("inf") and (type(limit) is not int or limit <= 0): raise ValueError("limit must be a positive integer.")
    def run():
        state = init_state(directory, manifest, manifest_path, workspace, bridge)
        persist(state)
        return drive(state, limit)
    return with_lock(directory, run)


def flow_status(directory): return view(read_json(Path(directory).absolute() / "state.json"))


def decide_flow(directory, request_id, choice, params=None, limit=float("inf")):
    directory, params = Path(directory).absolute(), params or {}
    def decide():
        state = read_json(directory / "state.json")
        request = state.get("pending")
        if not request or request["requestId"] != request_id or request["index"] != state["cursor"] or request["stepId"] != state["manifest"]["steps"][state["cursor"]]["id"]:
            raise ValueError("Decision does not match the current stage/request. Nothing was executed.")
        if not any(item["choice"] == choice for item in request["options"]): raise ValueError("Unknown choice for this request.")
        step = effective_step(state)
        changes = dict(state["overrides"].get(step["id"], {}))
        state["decisions"].append({"requestId": request_id, "stepId": step["id"], "index": state["cursor"], "choice": choice, "params": deepcopy(params), "recordedAt": now_iso(), "scope": "current-step"})
        if choice == "stop":
            state.update(status="STOPPED", pending=None, inflight=None)
            persist(state)
            return view(state)
        if choice in ("skip", "mark-completed", "continue"):
            result = (state.get("pendingResult") or {"status": "failed", "error": "Caller continued after interrupted operation"}) if choice == "continue" else {**params.get("result", {}), "status": "skipped" if choice == "skip" else "reported-completed", "attestation": "caller"}
            complete(state, step, result)
        else:
            if choice in ("merge", "overwrite"): changes["existingTarget"] = choice
            if choice == "new-directory":
                if params.get("path"): changes.update({"path" if step["op"] == "write" else "to": params["path"], "existingTarget": "ask"})
                else: changes["existingTarget"] = "new-directory"
            if choice == "use-source":
                if not isinstance(params.get("path"), str) or not params["path"]: raise ValueError("use-source needs params.path.")
                changes["path" if step["op"] == "input" else "from"] = params["path"]
                if step["op"] == "input": changes["onMismatch"] = "continue"
            if choice == "use-observed": changes["onMismatch"] = "continue"
            if choice == "create-empty": changes["missingSource"] = "create-empty"
            if choice == "replace-step":
                if not isinstance(params.get("step"), dict): raise ValueError("replace-step needs params.step.")
                changes.update({**step, **params["step"], "id": step["id"]})
                validate_flow({"schema": SCHEMA, "steps": [changes]})
            state["overrides"][step["id"]] = changes
            state.update(pending=None, inflight=None, pendingResult=None, preparedHost=None)
        state["status"] = "RUNNING"
        persist(state)
        return drive(state, limit)
    return with_lock(directory, decide)


def record_presented(directory, request_id):
    directory = Path(directory).absolute()
    def record():
        state = read_json(directory / "state.json")
        if not state.get("pending") or state["pending"]["requestId"] != request_id: raise ValueError("No matching current-stage question.")
        state["pending"]["presented"] = True
        persist(state)
        return view(state)
    return with_lock(directory, record)


def host_plan(directory, ignore_claim=False):
    state = read_json(Path(directory).absolute() / "state.json")
    request = state.get("hostRequest")
    if not request: return {"status": "NO_HOST_ACTION", "calls": [], "decisionRequest": None}
    answer = effective_response(state["bridge"], request["requestId"])
    if answer and answer["status"] != "unknown": return {"status": "HOST_RESPONSE_READY", "calls": [], "decisionRequest": None, "instruction": "Resume flow; do not invoke the connector again."}
    claimed = bool(answer and answer["status"] == "unknown") or (Path(state["directory"]) / "host-claims" / (request["requestId"] + ".json")).exists()
    payload, operation = request["payload"], request["operation"]
    records = [payload.get("artifact"), *payload.get("attachments", [])]
    if payload.get("bodyFile"): records.append({"path": payload["bodyFile"], "sha256": payload.get("bodySha256")})
    for record in filter(None, records):
        if record.get("path") and (not exists(record["path"]) or sha256_file(record["path"]) != record.get("sha256")):
            return {"status": "LOCAL_INPUT_CHANGED", "calls": [], "requestId": request["requestId"], "instruction": "Resume flow for a current-stage decision; the prepared bytes no longer match.", "ubuntu": "sha256sum -- " + shlex.quote(record["path"])}
    if claimed and not ignore_claim:
        if operation not in ("drive.upload", "gmail.send"): return {**host_plan(directory, True), "status": "HOST_READ_RETRY", "instruction": "Read-only call may be repeated; no operator question is needed."}
        if operation == "drive.upload":
            escape = lambda value: str(value).replace("\\", "\\\\").replace("'", "\\'")
            query = "trashed = false and name = '" + escape(payload["artifact"]["name"]) + "'"
            if payload.get("folderId"): query += " and '" + escape(payload["folderId"]) + "' in parents"
            calls = [{"tool": "Google_Drive.search", "arguments": {"query": "", "special_filter_query_str": query, "best_effort_fetch": False}}]
        else: calls = [{"tool": "Gmail.search_emails", "arguments": {"query": "in:sent to:(" + " ".join(payload["to"]) + ") subject:" + canonical(payload.get("subject")), "max_results": 10}}]
        return {"schema": "workspace-recover/host-action/v3", "status": "RECONCILE_HOST", "requestId": request["requestId"], "operation": operation, "calls": calls, "expected": payload, "note": "Do not resend an unknown write. Reconcile actual provider outcomes."}
    calls = []
    if operation == "drive.upload": calls = [{"tool": "Google_Drive.upload_file", "arguments": {"file_uri": payload["artifact"]["path"], "file_name": payload["artifact"]["name"], "parent_folder_id": payload.get("folderId"), "mime_type": payload["artifact"].get("mimeType", "application/octet-stream")}}]
    if operation in ("drive.metadata", "drive.download"):
        calls = [{"tool": "Google_Drive.get_file_metadata", "arguments": {"fileId": payload["id"]}}]
        if operation == "drive.download": calls.append({"tool": "Google_Drive.fetch", "arguments": {"url": "${metadata.webContentLink}", "create_raw_file": True, "include_base64": False}})
    if operation == "gmail.send": calls = [{"tool": "Gmail.send_email", "arguments": {"to": ",".join(payload["to"]), "subject": payload["subject"], "body_file": payload["bodyFile"], "content_type": "text/plain", "attachment_files": [a["path"] for a in payload.get("attachments", [])]}}]
    if operation == "gmail.read": calls = [{"tool": "Gmail.read_email", "arguments": {"message_id": payload["id"]}}, *[{"tool": "Gmail.read_attachment", "arguments": {"message_id": payload["id"], "filename": name}} for name in payload.get("attachmentNames", [])]]
    return {"schema": "workspace-recover/host-action/v3", "status": "HOST_ACTION", "requestId": request["requestId"], "operation": operation, "calls": calls,
            "reply": {"command": shlex.join(cli_argv("reply", "--session", state["directory"], "--result", "/path/to/raw-connector-result.json")), "downloadPathOption": "--path /exact/materialized/path"}, "note": "The host invokes authorized connectors and returns actual outputs."}


def claim_host(directory):
    directory = Path(directory).absolute()
    def claim():
        plan = host_plan(directory)
        if plan["status"] != "HOST_ACTION": return plan
        state = read_json(directory / "state.json")
        request = state["hostRequest"]
        exclusive_json(directory / "host-claims" / (request["requestId"] + ".json"), {"schema": "workspace-recover/host-claim/v3", "requestId": request["requestId"], "requestHash": request["requestHash"], "sessionId": request["sessionId"], "at": now_iso()})
        return {**plan, "status": "CLAIMED", "instruction": "Execute these calls once and submit actual outputs. After an interruption use host-plan for reconciliation."}
    return with_lock(directory, claim)


def reply_flow(directory, result, download_path=None, attachments=None):
    directory = Path(directory).absolute()
    def reply():
        state = read_json(directory / "state.json")
        request = state.get("hostRequest")
        if not request: raise ValueError("There is no pending host request.")
        raw = result
        while isinstance(raw.get("result"), dict) and not raw.get("id"): raw = raw["result"]
        item = {"requestId": request["requestId"], "requestHash": request["requestHash"], "sessionId": request["sessionId"]}
        if raw.get("error"):
            return submit_results(state["bridge"], {"schema": "workspace-recover/connector-results/v3", "results": [{**item, "status": "unknown" if request["operation"] in ("drive.upload", "gmail.send") else "failed", "error": raw["error"] if isinstance(raw["error"], str) else canonical(raw["error"])}]})
        normalized = {**raw, **({"path": str(Path(download_path).absolute())} if download_path else {})}
        normalized["id"] = normalized.get("id") or raw.get("message_id")
        if not normalized["id"]: raise ValueError("Connector output has no object/message ID.")
        if request["operation"] in ("drive.download", "drive.metadata", "gmail.read") and normalized["id"] != request["payload"]["id"]: raise ValueError("Connector output belongs to another requested object.")
        if request["operation"] == "drive.download":
            if not normalized.get("path"): raise ValueError("Supply the exact materialized file path with --path.")
            normalized["observed"] = file_record(normalized["path"])
        if request["operation"] == "drive.upload":
            parent = raw.get("parent_id") or raw.get("parent") or next(iter(raw.get("parent_ids", [])), None)
            folder = request["payload"].get("folderId")
            if folder and parent != folder and folder not in raw.get("parents", []): raise ValueError("Upload response does not confirm the requested folder. Read metadata before submitting.")
            normalized["parent"] = parent
        if request["operation"] == "gmail.read":
            file = directory / "received" / (request["requestId"] + "-body.txt")
            write_text(file, raw.get("body", ""))
            normalized.update(bodyFile=str(file), bodySha256=sha256_file(file))
            if attachments:
                seen, local_attachments = set(), []
                for item in attachments:
                    if not item.get("name") or item["name"] in seen or not any((a.get("filename") or a.get("name")) == item["name"] for a in raw.get("attachments", [])): raise ValueError("Attachment mapping is duplicate or absent in the actual parent message.")
                    seen.add(item["name"])
                    local_attachments.append({"name": item["name"], **file_record(item["path"])})
                normalized["localAttachments"] = local_attachments
        previous = effective_response(state["bridge"], request["requestId"])
        response = {"requestId": request["requestId"], "requestHash": request["requestHash"], "sessionId": request["sessionId"], "status": "completed", "result": normalized}
        if previous and previous["status"] == "unknown": response["resolvesSha256"] = digest(previous)
        receipt = submit_results(state["bridge"], {"schema": "workspace-recover/connector-results/v3", "results": [response]})
        if (state.get("pending") or {}).get("observation", {}).get("code") == "REMOTE_OUTCOME_UNKNOWN":
            state["observations"].append(observation("REMOTE_OUTCOME_RECONCILED", "The host returned an actual provider outcome.", stepId=state["pending"]["stepId"], requestId=request["requestId"]))
            state.update(pending=None, status="WAITING_HOST")
            persist(state)
        return receipt
    return with_lock(directory, reply)

"""Versioned legacy operation records and preserved error information."""
from pathlib import Path
import re
import threading
import traceback
from .formats import assert_format, schema
from .session_output import select_session
from .util import home_dir, session_id, now_iso, read_json, write_json, write_text


def terminal_state(state): return state in ("completed", "completed_with_warnings", "failed", "aborted")


class SessionStore:
    def __init__(self, root=None):
        self.root = Path(root or home_dir("state")).absolute()
        self._lock = threading.RLock()

    def directory(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"wr_[bri]_\d{14}_[a-f0-9]{12}", identifier): raise ValueError("invalid session ID")
        return self.root / "sessions" / identifier

    def create(self, operation, **extra):
        identifier = session_id({"backup": "wr_b", "restore": "wr_r", "init": "wr_i"}.get(operation, "wr_r"))
        self.directory(identifier).mkdir(parents=True, exist_ok=True)
        session = {"schema": schema("session"), "id": identifier, "operation": operation, "state": "running", "createdAt": now_iso(), "updatedAt": now_iso(), "next": None, "info": {}, **extra}
        self.save(session)
        select_session(identifier, self.directory(identifier) / "session.json")
        return session

    def load(self, identifier):
        file = self.directory(identifier) / "session.json"
        select_session(identifier, file)
        return assert_format(read_json(file), "session")

    def save(self, session):
        with self._lock:
            session["updatedAt"] = now_iso()
            write_json(self.directory(session["id"]) / "session.json", session)
        return session

    def write(self, identifier, relative, value, mode=0o600):
        file = self.directory(identifier) / relative
        if isinstance(value, (str, bytes)): write_text(file, value, mode)
        else: write_json(file, value, mode)
        return str(file)

    def set_info(self, session, kind, *, short, medium, full_path):
        session.setdefault("info", {})[kind] = {"short": short, "medium": medium, "fullPath": str(full_path)}
        self.save(session)

    def attempt(self, session, action):
        try: return action()
        except Exception as error:
            code = getattr(error, "code", None)
            if code in ("EXTERNAL_PENDING", "CAPABILITY_REQUIRED", "EXTERNAL_OUTCOME_UNKNOWN"):
                session["state"] = {"EXTERNAL_PENDING": "waiting_for_connector", "CAPABILITY_REQUIRED": "waiting_for_capability", "EXTERNAL_OUTCOME_UNKNOWN": "waiting_for_reconciliation"}[code]
                session["next"] = {**(session.get("next") or {}), "type": "automatic", "action": "reconcile-external-outcome" if code == "EXTERNAL_OUTCOME_UNKNOWN" else "host-connectors", "reason": str(error), "requestId": (getattr(error, "request", None) or {}).get("requestId")}
                return self.save(session)
            full_path = self.write(session["id"], "error.json", {"sessionId": session["id"], "operation": session["operation"], "failedAt": now_iso(), "message": str(error), "code": code, "stack": traceback.format_exc(), "progress": session.get("progress", {})})
            session.update(state="failed", result={**session.get("result", {}), "operation": "failed"})
            session["info"]["error"] = {"short": str(error), "medium": f"Operation: {session['operation']}\nCause: {error}\nPreserved evidence: {full_path}", "fullPath": full_path}
            session["next"] = {"type": "manual", "action": "inspect-error", "command": f"workspace-recover info {session['id']} --type error --view medium", "reason": "Inspect preserved evidence before starting a new operation."}
            self.save(session)
            error.session, error.state_root = session, self.root
            raise

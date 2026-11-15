"""Explicit invocation session reference, independent of stdout payload format."""
from contextvars import ContextVar
import json
from pathlib import Path
import sys

_reference = ContextVar("wr_result_session", default=None)


def reset_reference():
    _reference.set(None)


def select_session(identifier, path, *, flow=False):
    _reference.set((identifier, str(Path(path).absolute()), flow))


def report_reference():
    selected = _reference.get()
    identifier, path, flow = selected if selected else (None, None, False)
    if flow:
        # Read only the exact caller-selected record; never search another path.
        try:
            state = json.loads((Path(path) / "state.json").read_text(encoding="utf-8"))
            if state.get("schema") == "workspace-recover/flow-state/v3" and isinstance(state.get("sessionId"), str):
                identifier = state["sessionId"]
        except (OSError, ValueError, AttributeError):
            pass
    print("Session: " + json.dumps({"sessionId": identifier, "sessionPath": path}, ensure_ascii=True), file=sys.stderr)

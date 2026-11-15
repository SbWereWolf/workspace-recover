"""Observe actual CE calls while invoking WR's public Python CLI entry."""
import json
import os
from pathlib import Path
import runpy
import sys
import inspect
from contextlib import ExitStack
from unittest.mock import patch

from ce_bindings import resolve

log = Path(os.environ["CE_DELEGATION_LOG"])


def observe(role, original):
    def wrapped(*args, **kwargs):
        bound = inspect.signature(original).bind_partial(*args, **kwargs)
        first = next(iter(bound.arguments.values()), None)
        record = {"seam": role}
        if role in ("read", "write"):
            record["path"] = str(Path(first).absolute())
        elif isinstance(first, dict):
            record["argv"] = first.get("argv")
            if record["argv"] is None and first.get("commands"):
                record["argv"] = first["commands"][0].get("argv")
        # Do not capture environment values, document bodies or credentials.
        with log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        return original(*args, **kwargs)
    return wrapped


with ExitStack() as stack:
    for role in ("read", "write", "prepare", "execute"):
        module, name, original = resolve(role)
        stack.enter_context(patch.object(module, name, observe(role, original)))
    sys.argv = ["workspace-recover", *sys.argv[1:]]
    runpy.run_module("workspace_recover", run_name="__main__", alter_sys=True)

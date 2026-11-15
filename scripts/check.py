"""Check source syntax and unchanged external contracts with installed candidates."""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for file in (root / "src" / "workspace_recover").rglob("*.py"):
    ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
bindings = {"read": "command_execution.documents.read_json", "write": "command_execution.documents.write_json", "prepare": "command_execution.commands.prepare_invocation", "execute": "command_execution.processes.execute_invocation", "signal": "command_execution.processes.signal_process"}
selected = dict(os.environ)
selected["WR_TEST_COMMAND_JSON"] = json.dumps([sys.executable, "-I", "-B", "-m", "workspace_recover"])
selected["CE_TEST_BINDINGS_JSON"] = json.dumps(bindings)
raise SystemExit(subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(root / "tests" / "python"), "-p", "test_*.py", "-v"], cwd=root, env=selected, check=False).returncode)

"""Check current WR source syntax and complete current external contracts."""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for file in (root / "src" / "workspace_recover").rglob("*.py"):
    ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
selected = dict(os.environ)
selected["WR_TEST_COMMAND_JSON"] = json.dumps([sys.executable, "-I", "-B", "-m", "workspace_recover"])
# CE1 ownership contracts remain preserved; current shared-core counterparts
# belong to the accepted cross-application contract suite.
patterns = ["test_external_contract.py", "test_explicit_sessions_contract.py",
            "test_new_contract.py", "test_detached_reply_framing.py",
            "test_json_decoder_callers.py"]
results = [subprocess.run([sys.executable, "-B", "-m", "unittest", "discover",
           "-s", str(root / "tests" / "python"), "-p", pattern, "-v"],
           cwd=root, env=selected, check=False).returncode for pattern in patterns]
raise SystemExit(1 if any(results) else 0)

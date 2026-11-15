"""External CLI test facility; no application implementation is imported."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "command_fixture.py"


def command():
    selected = os.environ.get("WR_TEST_COMMAND_JSON")
    if selected:
        value = json.loads(selected)
        if not isinstance(value, list) or not value or not all(isinstance(x, str) for x in value):
            raise ValueError("WR_TEST_COMMAND_JSON must be a nonempty argv string array")
        return value
    return [sys.executable, "-P", "-s", "-B", "-m", "workspace_recover"]


class CliContract(unittest.TestCase):
    def setUp(self):
        parent = os.environ.get("WR_TEST_ARTIFACTS")
        if parent:
            Path(parent).mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="wr-external-", dir=parent))
        self.workspace = self.root / "workspace with spaces"
        self.workspace.mkdir()
        self.session = self.root / "flow-session"
        self.env = dict(os.environ)
        self.env.update(WORKSPACE_RECOVER_CONFIG_DIR=str(self.root / "config"),
                        WORKSPACE_RECOVER_STATE_DIR=str(self.root / "state"),
                        WORKSPACE_RECOVER_CACHE_DIR=str(self.root / "cache"),
                        PYTHONDONTWRITEBYTECODE="1")
        self.calls = []

    def tearDown(self):
        result = self._outcome.result
        failed = any(test is self for test, _ in result.failures + result.errors)
        if failed:
            print(f"Preserved contract evidence: {self.root}", file=sys.stderr)
        else:
            shutil.rmtree(self.root)

    def document(self, name, value):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
        return target

    def invoke(self, *argv, expected=0):
        process = subprocess.run([*command(), *map(str, argv)], cwd=self.workspace,
                                 env=self.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=30, check=False)
        self.calls.append((list(map(str, argv)), process.returncode))
        number = len(self.calls)
        (self.root / f"call-{number}.stdout").write_bytes(process.stdout)
        (self.root / f"call-{number}.stderr").write_bytes(process.stderr)
        self.assertEqual(process.returncode, expected,
                         f"argv={argv!r}\nstdout={process.stdout!r}\nstderr={process.stderr!r}")
        return process

    def answer(self, *argv, expected=0):
        return json.loads(self.invoke(*argv, expected=expected).stdout)

    def flow(self, steps, *, expected=0, **extra):
        manifest = self.document("flow.json", {"schema": "workspace-recover/flow/v3",
                                                "steps": steps, **extra})
        call = self.invoke if expected == 1 else self.answer
        return call("flow", "run", "--manifest", manifest,
                    "--session", self.session, "--workspace", self.workspace,
                    expected=expected)

    def resume(self, expected=0):
        return self.answer("flow", "run", "--session", self.session, expected=expected)

    def write_step(self, identifier, target, content="new", **options):
        return {"id": identifier, "op": "write", "path": target,
                "content": content, **options}

    def command_step(self, identifier, *args, **options):
        return {"id": identifier, "op": "command",
                "argv": [sys.executable, "-I", "-B", str(FIXTURE), *map(str, args)],
                **options}

    def state(self):
        return json.loads((self.session / "state.json").read_text(encoding="utf-8"))

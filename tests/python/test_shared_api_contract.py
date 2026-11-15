"""Executable accepted reader/process interfaces and actual delegation checks."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
import inspect

from ce_bindings import resolve
from support import CliContract, FIXTURE, ROOT


class SharedApiContract(unittest.TestCase):
    def cleanup_fixture(self, ready):
        if not ready.exists():
            return
        owned_pid = json.loads(ready.read_text())["pid"]
        self.assertIs(type(owned_pid), int)
        self.assertGreater(owned_pid, 1)
        self.assertNotEqual(owned_pid, os.getpid())
        # Use only the test-owned readiness witness, never an unchecked SDK handle.
        try:
            os.kill(owned_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(owned_pid, 0)
        except ChildProcessError:
            pass

    def call(self, role, *args):
        _, _, function = resolve(role)
        try:
            inspect.signature(function).bind(*args)
        except TypeError as exc:
            self.fail(f"Selected CE {role} lacks the accepted explicit public call shape: {exc}")
        # Runtime errors inside a shape-compatible candidate remain errors, not RED assertions.
        return function(*args)

    def options(self, **overrides):
        return {"mode": "foreground", "environment": "replace", "session": "inherit",
                "stdin": {"kind": "discard"}, "stdout": {"kind": "bytes"},
                "stderr": {"kind": "bytes"}, "timeout": None, **overrides}

    def test_explicit_profiles_distinguish_roots_and_duplicate_keys(self):
        with tempfile.TemporaryDirectory(prefix="ce-profile-contract-") as root:
            target = Path(root) / "input.json"
            target.write_text('{"x":1}')
            self.assertEqual(self.call("read", target, "wr-json-v1"), {"x": 1})
            cases = [('{"x":1}', {"x": 1}), ('[1,true]', [1, True]),
                     ('null', None), ('{"x":1,"x":2}', {"x": 2}),
                     ('{"o":{"x":1,"x":2}}', {"o": {"x": 2}})]
            for payload, expected in cases:
                with self.subTest(payload=payload):
                    target.write_text(payload)
                    actual = self.call("read", target, "wr-json-v1")
                    self.assertIs(type(actual), type(expected))
                    self.assertEqual(actual, expected)
            target.write_text('{"x":1}')
            self.assertEqual(self.call("read", target, "ce-object-v1"), {"x": 1})
            for payload in ('[1]', 'null', '{"x":1,"x":2}', '{"o":{"x":1,"x":2}}'):
                target.write_text(payload)
                try:
                    self.call("read", target, "ce-object-v1")
                except ValueError:
                    pass
                else:
                    self.fail("ce-object-v1 accepted a prohibited root or duplicate key")

    def test_generic_read_requires_a_profile_and_rejects_malformed_input(self):
        with tempfile.TemporaryDirectory(prefix="ce-profile-error-") as root:
            target = Path(root) / "input.json"
            target.write_text('{}')
            _, _, reader = resolve("read")
            with self.assertRaises((TypeError, ValueError)):
                reader(target)
            target.write_text('{"x":')
            for profile in ("ce-object-v1", "wr-json-v1"):
                with self.subTest(profile=profile):
                    try:
                        self.call("read", target, profile)
                    except ValueError:
                        pass
                    else:
                        self.fail("Malformed input was silently accepted")

    def test_foreground_result_retains_nonzero_exit_raw_bytes_and_exact_environment(self):
        with tempfile.TemporaryDirectory(prefix="ce-process-contract-") as root:
            invocation = {"argv": [sys.executable, "-I", "-B", str(FIXTURE), "--exit", "7",
                                    "--stdout-hex", "ff00", "--stderr-hex", "fe"],
                          "cwd": root, "env": {}}
            answer = self.call("execute", invocation, self.options())
            self.assertEqual(answer["kind"], "finished")
            self.assertEqual(answer["exit_code"], 7)
            self.assertIsNone(answer["signal"])
            self.assertEqual(answer["stdout"], b"\xff\x00")
            self.assertEqual(answer["stderr"], b"\xfe")
            self.assertFalse(answer["timed_out"])
            self.assertGreater(answer["pid"], 0)
            self.assertIsNone(answer["launch_error"])
            invocation["argv"] = [sys.executable, "-I", "-B", str(FIXTURE), "--print-env", "PATH"]
            exact = self.call("execute", invocation, self.options())
            self.assertEqual(exact["stdout"], b"absent")

    def test_definite_launch_failure_is_not_a_synthetic_exit_one(self):
        with tempfile.TemporaryDirectory(prefix="ce-launch-contract-") as root:
            answer = self.call("execute", {"argv": [str(Path(root) / "does-not-exist")],
                                            "cwd": root, "env": {}}, self.options())
            self.assertEqual(answer["kind"], "launch_failed")
            self.assertIsNone(answer["pid"])
            self.assertIsNone(answer["pgid"])
            self.assertIsNone(answer["exit_code"])
            self.assertIsNotNone(answer["launch_error"])

    def test_detached_submission_returns_a_live_handle_then_one_shot_signal(self):
        with tempfile.TemporaryDirectory(prefix="ce-detached-contract-") as root:
            directory = Path(root)
            ready = directory / "ready.json"
            options = self.options(mode="detached", environment="inherit", session="new",
                stdout={"kind": "file", "path": str(directory / "stdout"), "mode": "append"},
                stderr={"kind": "file", "path": str(directory / "stderr"), "mode": "append"})
            invocation = {"argv": [sys.executable, "-I", "-B", str(FIXTURE),
                                    "--ready-marker", str(ready), "--sleep", "5"],
                          "cwd": root, "env": {}}
            pid = None
            try:
                started = time.monotonic()
                answer = self.call("execute", invocation, options)
                self.assertLess(time.monotonic() - started, 1.5, "Detached submission waited for completion")
                self.assertEqual(answer["kind"], "submitted")
                pid = answer["pid"]
                self.assertGreater(pid, 0)
                self.assertEqual(answer["pgid"], pid)
                self.assertIsNone(answer["exit_code"])
                self.assertIsNone(answer["signal"])
                self.assertEqual(answer["completion"], "unobserved")
                deadline = time.monotonic() + 2
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "Setup/inconclusive: detached child did not become ready")
                self.assertEqual(json.loads(ready.read_text())["pid"], pid)
                self.assertEqual(os.getpgid(pid), pid)
                result = self.call("signal", {"scope": "group", "id": pid}, "SIGTERM")
                self.assertEqual(result if isinstance(result, str) else result["status"], "sent")
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    try:
                        ended, _ = os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        ended = pid
                    if ended == pid:
                        break
                    time.sleep(0.02)
                else:
                    self.fail("Fixture did not exit after the one-shot signal")
                absent = self.call("signal", {"scope": "group", "id": pid}, "SIGTERM")
                self.assertEqual(absent if isinstance(absent, str) else absent["status"], "absent")
            finally:
                self.cleanup_fixture(ready)

    def test_selected_shared_signal_capability_exists(self):
        resolve("signal")

    def test_signal_does_not_wait_retry_or_escalate_when_term_is_ignored(self):
        with tempfile.TemporaryDirectory(prefix="ce-signal-contract-") as root:
            directory = Path(root)
            ready, received = directory / "ready", directory / "term"
            options = self.options(mode="detached", session="new", environment="inherit",
                                   stdout={"kind": "discard"}, stderr={"kind": "discard"})
            pid = None
            try:
                answer = self.call("execute", {"argv": [sys.executable, "-I", "-B", str(FIXTURE),
                    "--ready-marker", str(ready), "--ignore-term", "--term-marker", str(received),
                    "--sleep", "5"], "cwd": root, "env": {}}, options)
                self.assertEqual(answer["kind"], "submitted")
                pid = answer["pid"]
                deadline = time.monotonic() + 2
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "Setup/inconclusive: signal control did not become ready")
                self.assertEqual(json.loads(ready.read_text())["pid"], pid)
                self.assertEqual(os.getpgid(pid), pid)
                started = time.monotonic()
                result = self.call("signal", {"scope": "group", "id": pid}, "SIGTERM")
                self.assertLess(time.monotonic() - started, 0.5, "One-shot signal waited for completion")
                self.assertEqual(result if isinstance(result, str) else result["status"], "sent")
                deadline = time.monotonic() + 1
                while not received.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(received.exists(), "The fixture never observed SIGTERM")
                time.sleep(0.35)
                os.kill(pid, 0)  # Must still exist; no hidden TERM->KILL escalation.
                ended, _ = os.waitpid(pid, os.WNOHANG)
                self.assertEqual(ended, 0, "One-shot signaling terminated the TERM-ignoring child")
            finally:
                self.cleanup_fixture(ready)


class WrDelegationContract(CliContract):
    def test_python_cli_uses_the_selected_shared_read_write_prepare_and_execute_seams(self):
        self.assertTrue((ROOT / "pyproject.toml").exists(),
                        "Python WR/delegation capability absent; do not invoke an absent module as RED")
        driver = Path(__file__).parent / "delegation_driver.py"
        self.env["CE_DELEGATION_LOG"] = str(self.root / "ce-calls.jsonl")
        # The selected test interpreter must have the identified Python WR/CE candidates installed.
        old = os.environ.get("WR_TEST_COMMAND_JSON")
        os.environ["WR_TEST_COMMAND_JSON"] = json.dumps([sys.executable, "-B", str(driver)])
        try:
            marker = self.workspace / "delegated-marker"
            self.flow([self.command_step("delegated", "--write", marker, "--content", "shared invocation")])
        finally:
            if old is None:
                os.environ.pop("WR_TEST_COMMAND_JSON", None)
            else:
                os.environ["WR_TEST_COMMAND_JSON"] = old
        self.assertEqual(marker.read_text(), "shared invocation")
        log = Path(self.env["CE_DELEGATION_LOG"])
        self.assertTrue(log.is_file(), "WR performed the operation without calling selected CE seams")
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertTrue(any(row.get("seam") == "read" and row.get("path") == str(self.root / "flow.json") for row in calls))
        self.assertTrue(any(row.get("seam") == "write" and row.get("path") == str(self.session / "state.json") for row in calls))
        for role in ("prepare", "execute"):
            self.assertTrue(any(row.get("seam") == role and str(FIXTURE) in (row.get("argv") or []) for row in calls),
                            f"Actual command invocation did not delegate to CE {role}")

#!/usr/bin/env python3
"""Exercise the application's source transport and commands without a Poise database."""

from __future__ import annotations

import importlib.util
import json
import os
import selectors
import shlex
import shutil
import subprocess
import sys
import platform
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
WRAPPER_ROOT = ROOT / "task-management"


class BackendFixture(unittest.TestCase):
    def setUp(self) -> None:
        runtime_tmp = Path(os.environ["TMPDIR"]).resolve(strict=True)
        self.temp = tempfile.TemporaryDirectory(dir=runtime_tmp)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.launcher = self.root / "erp.sh"
        self.launcher.write_text(
            '#!/usr/bin/env bash\n'
            'record="$(mktemp "${ERP_PROXY_TEST_LOG}.XXXXXX")"\n'
            'printf "%s\\0" "$PWD" "${CODEX_THREAD_ID:-}" '
            '"${POISE_CALLER_BINDING:-}" "$@" > "$record"\n'
            'cat\n',
            encoding="utf-8",
        )
        self.call_log = self.root / "call.log"
        self.project = self.root / "projects/erp/config/project.json"
        self.project.parent.mkdir(parents=True)
        self.project.write_text(
            json.dumps({"project": "erp", "paths": {"state": str(self.root / "state")}}),
            encoding="utf-8",
        )
        self.settings = self.root / "workflow-backend.settings.json"
        self.settings.write_text(
            json.dumps(
                {
                    "schema_version": 3,
                    "backend": "poise",
                    "project_id": "erp",
                    "launcher": "erp.sh",
                    "working_directory": ".",
                    "project_config": "projects/erp/config/project.json",
                }
            ),
            encoding="utf-8",
        )
        self.environment = patch.dict(
            os.environ,
            {"CODEX_THREAD_ID": "actor-123", "ERP_PROXY_TEST_LOG": str(self.call_log),
             "POISE_CALLER_BINDING": "", "TASK_MANAGEMENT_SETTINGS": "",
             "TASK_MANAGEMENT_PYTHON": ""},
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop("CODEX_SESSION_ID", None)

    def calls(self) -> list[list[str]]:
        return [
            [part.decode("utf-8") for part in record.read_bytes().removesuffix(b"\0").split(b"\0")]
            for record in sorted(self.root.glob("call.log.*"))
        ]

    def clear_calls(self) -> None:
        for record in self.root.glob("call.log.*"):
            record.unlink()


class LedgerFixtureTests(BackendFixture):
    def test_ledger_detects_discarded_duplicate_call(self) -> None:
        packet = b'{"operation":"show"}'
        command = ["bash", str(self.launcher), "hook-work"]
        subprocess.run(command, input=packet, cwd=self.root, capture_output=True, check=False)
        second = subprocess.run(command, input=packet, cwd=self.root, capture_output=True, check=False)
        self.assertEqual(second.stdout, packet)
        expected = [str(self.root), "actor-123", "", "hook-work"]
        self.assertEqual(self.calls(), [expected, expected])
        self.assertEqual({name: os.environ[name] for name in
                          ("POISE_CALLER_BINDING", "TASK_MANAGEMENT_SETTINGS", "TASK_MANAGEMENT_PYTHON")},
                         {"POISE_CALLER_BINDING": "", "TASK_MANAGEMENT_SETTINGS": "", "TASK_MANAGEMENT_PYTHON": ""})
        with self.assertRaises(AssertionError):
            self.assertEqual(self.calls(), [expected])


class WorkflowProxyTests(BackendFixture):
    def setUp(self) -> None:
        super().setUp()
        source = WRAPPER_ROOT / "src/task_management/workflow_proxy.py"
        spec = importlib.util.spec_from_file_location("workflow_proxy_under_test", source)
        self.proxy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.proxy)

    def command(self, tool: str, arguments: list[str]) -> list[str]:
        source = WRAPPER_ROOT / "src/task_management/workflow_proxy.py"
        dispatcher = "import runpy,sys; entry=runpy.run_path(sys.argv[1]); sys.exit(entry['main'](sys.argv[2:]))"
        return [sys.executable, "-I", "-B", "-c", dispatcher, str(source), tool, *arguments]

    def console(self, tool: str, arguments: list[str], packet: bytes) -> subprocess.CompletedProcess:
        environment = dict(os.environ, TASK_MANAGEMENT_SETTINGS=str(self.settings))
        return subprocess.run(self.command(tool, arguments),
                              input=packet, capture_output=True, cwd=self.root,
                              env=environment, check=False)

    def test_explicit_configuration_overrides_setup_default(self) -> None:
        chosen_directory = self.root / "explicit working directory"
        chosen_directory.mkdir()
        selected = self.root / "explicit configuration.json"
        values = json.loads(self.settings.read_bytes())
        values["working_directory"] = chosen_directory.name
        selected.write_text(json.dumps(values), encoding="utf-8")
        packet = b'{"operation":"show","input":{},"messages":[]}\n'
        result = self.console("task-ctl", ["--config", os.path.relpath(selected, WRAPPER_ROOT)], packet)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, packet, b""))
        self.assertEqual(self.calls(), [[str(chosen_directory), "actor-123", "", "work"]])

    def test_missing_explicit_configuration_does_not_use_setup_default(self) -> None:
        selected = self.root / "absent explicit.json"
        result = self.console("task-ctl", ["--config", str(selected)], b'{"operation":"show"}')
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(str(selected).encode(), result.stderr)
        self.assertEqual(self.calls(), [])

    def test_explicit_configuration_preserves_command_arguments(self) -> None:
        arguments = ["requirements", "--config", "literal backend config.json", "--help"]
        result = self.console("exec-ctl", ["--config", str(self.settings), "--command", *arguments], b"")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))
        self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", *arguments]])

    def test_command_mode_preserves_representative_families_and_literal_arguments(self) -> None:
        commands = (
            "handoff-proxy", "telemetry", "source-index", "result-view",
            "tool-result", "checks", "checks-mcp", "content-read", "placement",
            "infra", "deps", "check", "local-assets", "project", "next",
            "project-config", "project-init", "work", "runtime", "goal-config",
            "catalogue", "skills", "runtime-setup", "runtime-config", "hook",
            "hook-work", "backup", "route-migrate", "task-workflow-migrate", "requirements",
        )
        arguments = ["", "two words", "данные", "$(touch injected)", "; touch injected", "--config", "explicit target"]
        packet = b"\x00\xffnot JSON\r\n"
        with self.launcher.open("a", encoding="utf-8") as output:
            output.write('printf "%s" "$POISE_CONFIG" >&2\n')
        for command in commands:
            with self.subTest(command=command):
                self.clear_calls()
                result = self.console("exec-ctl", ["--command", command, *arguments], packet)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (0, packet, str(self.project).encode()))
                self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", command, *arguments]])
        self.assertFalse((self.root / "injected").exists())

    def test_command_mode_rejects_local_syntax_and_invalid_caller_before_launch(self) -> None:
        for tool, arguments in (
            ("exec-ctl", ["--command"]), ("exec-ctl", ["--command", ""]),
            ("exec-ctl", ["--cli", "next"]), ("exec-ctl", ["next"]),
            ("task-ctl", ["--command", "work"]), ("sprint-ctl", ["--command", "work"]),
            ("req-ctl", ["--command", "requirements"]),
        ):
            with self.subTest(tool=tool, arguments=arguments):
                result = self.console(tool, arguments, b"invalid input")
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertTrue(result.stderr)
                self.assertEqual(self.calls(), [])
        for values in ({"CODEX_THREAD_ID": ""}, {"CODEX_SESSION_ID": "other"},
                       {"POISE_CALLER_BINDING": "foreign"}):
            with self.subTest(values=values), patch.dict(os.environ, values):
                result = self.console("exec-ctl", ["--command", "next"], b"")
                self.assertEqual(result.returncode, 3)
                self.assertEqual(result.stdout, b"")
                self.assertTrue(result.stderr)
                self.assertEqual(self.calls(), [])

    def test_command_mode_rejects_invalid_configuration_before_launch(self) -> None:
        original = json.loads(self.settings.read_text(encoding="utf-8"))
        for updates in ({"schema_version": True}, {"backend": "unknown"},
                        {"launcher": "relative.sh"}, {"project_config": str(self.root / "absent.json")}):
            with self.subTest(updates=updates):
                self.settings.write_text(json.dumps({**original, **updates}), encoding="utf-8")
                result = self.console("exec-ctl", ["--command", "next"], b"")
                self.assertEqual(result.returncode, 3)
                self.assertEqual(result.stdout, b"")
                self.assertTrue(result.stderr)
                self.assertEqual(self.calls(), [])

    def test_command_mode_preserves_backend_unknown_errors_and_signal_status(self) -> None:
        for body, expected in (
            ('printf "unknown command\\n" >&2; exit 7\n', (7, b"", b"unknown command\n")),
            ('printf "partial"; printf "diagnostic" >&2; exit 19\n', (19, b"partial", b"diagnostic")),
            ('kill -TERM $$\n', (143, b"", b"")),
        ):
            with self.subTest(body=body):
                self.launcher.write_text(body, encoding="utf-8")
                result = self.console("exec-ctl", ["--command", "future-command"], b"")
                self.assertEqual((result.returncode, result.stdout, result.stderr), expected)

    def test_command_mode_streams_prompt_before_stdin_eof(self) -> None:
        self.launcher.write_text('printf "ready\\n"\ncat\nprintf "done\\n" >&2\n', encoding="utf-8")
        environment = dict(os.environ, TASK_MANAGEMENT_SETTINGS=str(self.settings))
        with subprocess.Popen(self.command("exec-ctl", ["--command", "project-init"]), cwd=self.root, env=environment,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(5), "Backend prompt must arrive while stdin is open")
                    self.assertEqual(os.read(process.stdout.fileno(), 6), b"ready\n")
                packet = b"\x00\xffinteractive\r\n"
                stdout, stderr = process.communicate(packet, timeout=5)
                self.assertEqual((process.returncode, stdout, stderr), (0, packet, b"done\n"))
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=5)

    def test_known_operations_preserve_packet_and_identity(self) -> None:
        operations = {
            "task-ctl": ("task", "show"),
            "sprint-ctl": ("sprint", "show"),
            "req-ctl": ("query",),
            "exec-ctl": (
                "restore_context", "routing", "bootstrap", "verify", "show",
                "accept", "reuse", "recover_empty_rework", "recover_empty_advance",
                "advance", "recover_missing_worktree", "recover_ownership",
                "recover_artifacts", "artifact_drafts", "cancel",
                "artifacts", "integrate", "cleanup", "initialize_stage_contracts",
                "revise_stage_contract", "release", "delivery", "handoff", "task_feedback",
            ),
        }
        for tool, names in operations.items():
            for operation in names:
                with self.subTest(tool=tool, operation=operation):
                    self.clear_calls()
                    messages = '' if tool == "req-ctl" else ', "messages": []'
                    packet = f'{{ "operation": "{operation}", "input": {{}}{messages} }}\n'.encode()
                    result = self.proxy.execute(tool, packet, self.settings)
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, packet)
                    self.assertEqual(result.stderr, b"")
                    expected = (
                        ["requirements", "--config", str(self.project)]
                        if tool == "req-ctl"
                        else ["work"]
                    )
                    self.assertEqual(
                        self.calls(),
                        [[str(Path.cwd()) if tool == "req-ctl" else str(self.root),
                          "actor-123", "", *expected]],
                    )

    def test_retired_protocol_operations_do_not_start_backend(self) -> None:
        for operation in ("transfer",):
            with self.subTest(operation=operation):
                self.clear_calls()
                packet = json.dumps({"operation": operation, "input": {}, "messages": []}).encode()
                result = self.console("exec-ctl", [], packet)
                self.assertEqual((result.returncode, result.stdout), (2, b""))
                self.assertIn(operation.encode(), result.stderr)
                self.assertEqual(self.calls(), [])

    def test_unknown_operation_is_reported_before_backend_call(self) -> None:
        cases = (
            ("task-ctl", "sprint"),
            ("sprint-ctl", "task"),
            ("req-ctl", "advance"),
            ("exec-ctl", "query"),
            ("exec-ctl", "task"),
            ("task-ctl", "not_registered"),
        )
        cases += tuple((tool, operation)
                       for owner, operations in (("exec-ctl", ("release", "delivery", "handoff", "task_feedback")),
                                                 ("req-ctl", ("command", "apply", "rollback", "squash", "rebase", "export")))
                       for operation in operations
                       for tool in ("task-ctl", "sprint-ctl", "req-ctl", "exec-ctl")
                       if tool != owner)
        for tool, operation in cases:
            with self.subTest(tool=tool, operation=operation):
                self.clear_calls()
                packet = json.dumps({"operation": operation, "input": {}}).encode()
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute(tool, packet, self.settings)
                self.assertEqual(captured.exception.exit_code, 2)
                self.assertIn(operation, str(captured.exception))
                self.assertEqual(self.calls(), [])

    def test_task_feedback_preserves_actions_and_repeated_append(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures"
        with self.launcher.open("a", encoding="utf-8") as output:
            output.write('printf "%s" "$POISE_CONFIG" >&2\n')
        for action in ("append", "read", "read_attachment"):
            with self.subTest(action=action):
                self.clear_calls()
                packet = (fixtures / f"task-feedback-{action}.json").read_bytes()
                count = 2 if action == "append" else 1
                for _ in range(count):
                    result = self.console("exec-ctl", [], packet)
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (0, packet, str(self.project).encode()))
                self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]] * count)

    def test_task_feedback_preserves_native_results_and_refusals(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures"
        self.launcher.write_text(self.launcher.read_text(encoding="utf-8").replace(
            'cat\n', 'cat > "$ERP_PROXY_TEST_INPUT"\n'), encoding="utf-8")
        with self.launcher.open("a", encoding="utf-8") as output:
            output.write('cat -- "$ERP_PROXY_TEST_RESPONSE"\n'
                         'printf "native diagnostic\\n" >&2\n'
                         'exit "$ERP_PROXY_TEST_STATUS"\n')
        cases = (("append", "appended", 0), ("read", "listing", 0),
                 ("read_attachment", "attachment", 0), ("read", "refused", 2))
        for action, outcome, status in cases:
            with self.subTest(outcome=outcome):
                self.clear_calls()
                packet = (fixtures / f"task-feedback-{action}.json").read_bytes()
                response = fixtures / f"task-feedback-{outcome}.json"
                with patch.dict(os.environ, {"ERP_PROXY_TEST_RESPONSE": str(response),
                                             "ERP_PROXY_TEST_INPUT": str(self.root / "input.json"),
                                             "ERP_PROXY_TEST_STATUS": str(status)}):
                    result = self.console("exec-ctl", [], packet)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (status, response.read_bytes(), b"native diagnostic\n"))
                self.assertEqual((self.root / "input.json").read_bytes(), packet)
                self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_task_feedback_requires_real_caller_before_dispatch(self) -> None:
        packet = (WRAPPER_ROOT / "tests/fixtures/task-feedback-read.json").read_bytes()
        os.environ.pop("CODEX_THREAD_ID", None)
        result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn("настоящий сеанс".encode(), result.stderr)
        self.assertEqual(self.calls(), [])

    def test_handoff_preserves_packet_target_and_exact_retries(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures/poise-workflow/transport"
        for filename in ("native-handoff.json", "native-handoff-target.json"):
            with self.subTest(packet=filename):
                self.clear_calls()
                packet = (fixtures / filename).read_bytes()
                for _ in range(2):
                    result = self.console("exec-ctl", [], packet)
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (0, packet, b""))
                self.assertEqual(self.calls(),
                                 [[str(self.root), "actor-123", "", "work"]] * 2)

    def test_handoff_preserves_native_outcomes_and_saved_result(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures/poise-workflow/transport"
        packet = (fixtures / "native-handoff.json").read_bytes()
        self.launcher.write_text(
            self.launcher.read_text(encoding="utf-8").replace(
                'cat\n',
                'cat > "$ERP_PROXY_TEST_INPUT"\n'
                'printf "%s" "$POISE_CONFIG" > "$ERP_PROXY_TEST_CONFIG"\n'
                'cp -- "$ERP_PROXY_TEST_FULL" saved-response.json\n'
                'cat -- "$ERP_PROXY_TEST_RESPONSE"\n'
                'printf "native diagnostic\\n" >&2\n'
                'exit "$ERP_PROXY_TEST_STATUS"\n',
            ),
            encoding="utf-8",
        )
        cases = (("complete", 0), ("verification", 1),
                 ("progression", 1), ("release", 2))
        for outcome, status in cases:
            with self.subTest(outcome=outcome):
                self.clear_calls()
                response = fixtures / f"native-handoff-{outcome}.json"
                full = (fixtures / "native-handoff-saved-result.json"
                        if outcome == "complete" else response)
                with patch.dict(os.environ, {
                    "ERP_PROXY_TEST_INPUT": str(self.root / "input.json"),
                    "ERP_PROXY_TEST_CONFIG": str(self.root / "config.txt"),
                    "ERP_PROXY_TEST_FULL": str(full),
                    "ERP_PROXY_TEST_RESPONSE": str(response),
                    "ERP_PROXY_TEST_STATUS": str(status),
                }):
                    result = self.console("exec-ctl", [], packet)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (status, response.read_bytes(), b"native diagnostic\n"))
                self.assertEqual((self.root / "input.json").read_bytes(), packet)
                self.assertEqual((self.root / "config.txt").read_text(), str(self.project))
                self.assertEqual((self.root / "saved-response.json").read_bytes(),
                                 full.read_bytes())
                self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_handoff_rejects_missing_caller_before_dispatch(self) -> None:
        packet = (WRAPPER_ROOT / "tests/fixtures/poise-workflow/transport/native-handoff.json").read_bytes()
        with patch.dict(os.environ, {"CODEX_THREAD_ID": ""}):
            result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(b"CODEX_THREAD_ID", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_handoff_preserves_backend_signal_exit_status(self) -> None:
        packet = (WRAPPER_ROOT / "tests/fixtures/poise-workflow/transport/native-handoff.json").read_bytes()
        self.launcher.write_text('#!/usr/bin/env bash\nkill -TERM "$$"\n', encoding="utf-8")
        result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (143, b"", b""))

    def test_verify_forms_preserve_packet_identity_and_exact_retries(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures/poise-workflow/selection"
        for name in ("selected-verify.json", "full-verify.json"):
            with self.subTest(packet=name):
                self.clear_calls()
                packet = (fixtures / name).read_bytes()
                for _ in range(2):
                    result = self.console("exec-ctl", [], packet)
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (0, packet, b""))
                self.assertEqual(self.calls(),
                                 [[str(self.root), "actor-123", "", "work"]] * 2)

    def test_selected_verify_preserves_saved_receipt_and_continuation(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures/poise-workflow/selection"
        packet = (fixtures / "selected-verify.json").read_bytes()
        self.launcher.write_text(
            self.launcher.read_text(encoding="utf-8").replace(
                'cat\n',
                'cat > "$ERP_PROXY_TEST_INPUT"\n'
                'printf "%s" "$POISE_CONFIG" > "$ERP_PROXY_TEST_CONFIG"\n'
                'cp -- "$ERP_PROXY_TEST_FULL" saved-response.json\n'
                'cat -- "$ERP_PROXY_TEST_RESPONSE"\n',
            ), encoding="utf-8",
        )
        with patch.dict(os.environ, {
            "ERP_PROXY_TEST_INPUT": str(self.root / "input.json"),
            "ERP_PROXY_TEST_CONFIG": str(self.root / "config.txt"),
            "ERP_PROXY_TEST_FULL": str(fixtures / "saved-response.json"),
            "ERP_PROXY_TEST_RESPONSE": str(fixtures / "verified-response.json"),
        }):
            result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, (fixtures / "verified-response.json").read_bytes(), b""))
        self.assertEqual((self.root / "input.json").read_bytes(), packet)
        self.assertEqual((self.root / "config.txt").read_text(), str(self.project))
        self.assertEqual((self.root / "saved-response.json").read_bytes(),
                         (fixtures / "saved-response.json").read_bytes())
        self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_selected_verify_preserves_native_refusals_without_fallback(self) -> None:
        fixtures = WRAPPER_ROOT / "tests/fixtures/poise-workflow/selection"
        packet = (fixtures / "selected-verify.json").read_bytes()
        cases = json.loads((fixtures / "native-refusals.json").read_text(encoding="utf-8"))
        self.launcher.write_text(
            self.launcher.read_text(encoding="utf-8").replace(
                'cat\n',
                'cat > "$ERP_PROXY_TEST_INPUT"\n'
                'printf "%s" "$ERP_PROXY_TEST_STDOUT"\n'
                'printf "%s" "$ERP_PROXY_TEST_STDERR" >&2\n'
                'exit "$ERP_PROXY_TEST_STATUS"\n',
            ), encoding="utf-8",
        )
        for case in cases:
            with self.subTest(native_refusal=case["kind"]):
                self.clear_calls()
                with patch.dict(os.environ, {
                    "ERP_PROXY_TEST_INPUT": str(self.root / "input.json"),
                    "ERP_PROXY_TEST_STDOUT": case["stdout"],
                    "ERP_PROXY_TEST_STDERR": case["stderr"],
                    "ERP_PROXY_TEST_STATUS": str(case["exit"]),
                }):
                    result = self.console("exec-ctl", [], packet)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (case["exit"], case["stdout"].encode(), case["stderr"].encode()))
                self.assertEqual((self.root / "input.json").read_bytes(), packet)
                self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_selected_verify_rejects_missing_caller_before_dispatch(self) -> None:
        packet = (WRAPPER_ROOT / "tests/fixtures/poise-workflow/selection/selected-verify.json").read_bytes()
        with patch.dict(os.environ, {"CODEX_THREAD_ID": ""}):
            result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(b"CODEX_THREAD_ID", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_selected_verify_preserves_native_signal_status(self) -> None:
        packet = (WRAPPER_ROOT / "tests/fixtures/poise-workflow/selection/selected-verify.json").read_bytes()
        self.launcher.write_text('#!/usr/bin/env bash\nkill -TERM "$$"\n', encoding="utf-8")
        result = self.console("exec-ctl", [], packet)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (143, b"", b""))

    def test_invalid_packet_is_reported_before_backend_call(self) -> None:
        packets = (
            b'{"operation":"show","operation":"task"}',
            b'{"operation":',
            b'\xff',
            b'[]',
            b'{"input":{}}',
            b'{"operation":null,"input":{}}',
            b'{"operation":42,"input":{}}',
        )
        for packet in packets:
            with self.subTest(packet=packet):
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute("task-ctl", packet, self.settings)
                self.assertEqual(captured.exception.exit_code, 2)
                self.assertEqual(self.calls(), [])

    def test_backend_failure_is_not_masked(self) -> None:
        self.launcher.write_text(
            '#!/usr/bin/env bash\nprintf "backend output\\n"\n'
            'printf "backend failed\\n" >&2\nexit 7\n',
            encoding="utf-8",
        )
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, b"backend output\n")
        self.assertEqual(result.stderr, b"backend failed\n")

    def test_backend_signal_is_not_masked(self) -> None:
        self.launcher.write_text('#!/usr/bin/env bash\nkill -TERM "$$"\n', encoding="utf-8")
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.returncode, -15)

    def test_binding_rejection_receipt_is_not_masked(self) -> None:
        receipt = b'{"status":"rejected","reason":"Stale or changed hook binding"}\n'
        self.launcher.write_text(
            '#!/usr/bin/env bash\nprintf \'%s\\n\' '
            '\'{"status":"rejected","reason":"Stale or changed hook binding"}\'\nexit 2\n',
            encoding="utf-8",
        )
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, receipt)
        self.assertEqual(result.stderr, b"")

    def test_missing_config_is_dependency_error(self) -> None:
        with self.assertRaises(self.proxy.ProxyError) as captured:
            self.proxy.execute("task-ctl", b'{"operation":"show"}', self.root / "missing.json")
        self.assertEqual(captured.exception.exit_code, 3)

    def test_missing_launcher_is_dependency_error(self) -> None:
        values = json.loads(self.settings.read_text(encoding="utf-8"))
        values["launcher"] = str(self.root / "missing-erp.sh")
        self.settings.write_text(json.dumps(values), encoding="utf-8")
        with self.assertRaises(self.proxy.ProxyError) as captured:
            self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(captured.exception.exit_code, 3)
        self.assertEqual(self.calls(), [])

    def test_boolean_schema_version_is_rejected(self) -> None:
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["schema_version"] = True
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        with self.assertRaises(self.proxy.ProxyError) as captured:
            self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(captured.exception.exit_code, 3)
        self.assertEqual(self.calls(), [])

    def test_invalid_configuration_never_calls_backend(self) -> None:
        original = json.loads(self.settings.read_text(encoding="utf-8"))
        cases = (
            {**original, "backend": "other"},
            {**original, "launcher": "relative/erp.sh"},
            {**original, "launcher": []},
            {**original, "launcher": "/invalid\u0000path"},
            {**original, "schema_version": 1},
            {**original, "working_directory": str(self.root / "missing")},
            {**original, "project_config": str(self.root / "missing.json")},
            {**original, "project_config": 42},
            {key: value for key, value in original.items() if key != "launcher"},
        )
        for settings in cases:
            with self.subTest(settings=settings):
                self.settings.write_text(json.dumps(settings), encoding="utf-8")
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
                self.assertEqual(captured.exception.exit_code, 3)
                self.assertEqual(self.calls(), [])

    def test_duplicate_config_key_is_rejected(self) -> None:
        raw = self.settings.read_text(encoding="utf-8")
        self.settings.write_text(raw[:-1] + ',"backend":"poise"}', encoding="utf-8")
        with self.assertRaises(self.proxy.ProxyError) as captured:
            self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(captured.exception.exit_code, 3)
        self.assertEqual(self.calls(), [])

    def test_unknown_configuration_key_is_ignored(self) -> None:
        values = json.loads(self.settings.read_text(encoding="utf-8"))
        values["future_option"] = {"enabled": True}
        values.update({"binding": "/foreign/session", "hook_settings": "/missing/hooks",
                       "command": ["/wrong/project-launcher"]})
        self.settings.write_text(json.dumps(values), encoding="utf-8")
        packet = b'{"operation":"show"}'
        result = self.proxy.execute("task-ctl", packet, self.settings)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, packet, b""))
        self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_same_settings_forward_each_callers_native_session(self) -> None:
        before = self.settings.read_bytes()
        for session in ("actor-first", "actor-second"):
            with patch.dict(os.environ, {"CODEX_THREAD_ID": session}):
                result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
                self.assertEqual(result.returncode, 0)
        self.assertCountEqual(self.calls(), [
            [str(self.root), "actor-first", "", "work"],
            [str(self.root), "actor-second", "", "work"],
        ])
        self.assertEqual(self.settings.read_bytes(), before)

    def test_native_aliases_are_forwarded_to_erp_launcher(self) -> None:
        self.launcher.write_text(
            '#!/usr/bin/env bash\nprintf "%s\\0%s\\0%s" "${CODEX_THREAD_ID-}" '
            '"${CODEX_SESSION_ID-}" "$1"\n', encoding="utf-8")
        for aliases, expected_thread, expected_session in (
            ({"CODEX_THREAD_ID": "thread-only"}, "thread-only", None),
            ({"CODEX_SESSION_ID": "session-only"}, None, "session-only"),
            ({"CODEX_THREAD_ID": "same", "CODEX_SESSION_ID": "same"}, "same", "same"),
        ):
            with self.subTest(aliases=aliases), patch.dict(os.environ, {}, clear=True):
                os.environ.update(aliases)
                result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
                self.assertEqual((result.returncode, result.stderr), (0, b""))
                self.assertEqual(result.stdout, "\0".join(
                    [expected_thread or "", expected_session or "", "work"]).encode())

    def test_requirements_do_not_require_native_identity(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            os.environ["ERP_PROXY_TEST_LOG"] = str(self.call_log)
            result = self.proxy.execute("req-ctl", b'{"operation":"query"}', self.settings)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [[str(Path.cwd()), "", "", "requirements", "--config", str(self.project)]])

    def test_selected_project_overrides_inherited_project_without_mutating_parent(self) -> None:
        self.launcher.write_text('#!/usr/bin/env bash\nprintf "%s" "$POISE_CONFIG"\n', encoding="utf-8")
        with patch.dict(os.environ, {"POISE_CONFIG": "/wrong/project.json"}):
            for tool in ("task-ctl", "sprint-ctl", "exec-ctl"):
                self.assertEqual(self.proxy.execute(tool, b'{"operation":"show"}', self.settings).stdout,
                                 str(self.project.resolve()).encode())
            self.assertEqual(os.environ["POISE_CONFIG"], "/wrong/project.json")

    def test_same_manifest_symlink_is_not_a_false_mismatch(self) -> None:
        alias = self.root / "project-alias.json"
        alias.symlink_to(self.project)
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["project_config"] = os.path.relpath(alias, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]])

    def test_canonical_erp_manifest_is_forwarded(self) -> None:
        canonical = self.root / "projects/erp/config/project.json"
        canonical.parent.mkdir(parents=True, exist_ok=True)
        canonical.write_text('{"project":"erp"}', encoding="utf-8")
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["project_config"] = os.path.relpath(canonical, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        packet = b'{"operation":"show"}'
        for tool in ("task-ctl", "sprint-ctl", "exec-ctl"):
            with self.subTest(tool=tool):
                result = self.proxy.execute(tool, packet, self.settings)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, packet, b""))
        self.assertEqual(self.calls(), [[str(self.root), "actor-123", "", "work"]] * 3)

    def test_explicit_relocated_erp_manifest_is_forwarded(self) -> None:
        project = self.root / "project-configurations/erp/config/project.json"
        project.parent.mkdir(parents=True)
        project.write_text('{"project":"erp"}', encoding="utf-8")
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["project_config"] = os.path.relpath(project, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        self.launcher.write_text(
            '#!/usr/bin/env bash\nprintf "%s" "$POISE_CONFIG"\n', encoding="utf-8")
        for tool in ("task-ctl", "sprint-ctl", "exec-ctl", "req-ctl"):
            with self.subTest(tool=tool):
                operation = "query" if tool == "req-ctl" else "show"
                result = self.proxy.execute(tool, json.dumps({"operation": operation}).encode(), self.settings)
                self.assertEqual((0, str(project).encode(), b""),
                                 (result.returncode, result.stdout, result.stderr))

    def test_manifest_without_project_identity_is_rejected_before_backend_call(self) -> None:
        missing = self.root / "profile/erp/project.json"
        missing.parent.mkdir(parents=True, exist_ok=True)
        missing.write_text('{"paths":{}}', encoding="utf-8")
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["project_config"] = os.path.relpath(missing, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        for tool, operation in (("task-ctl", "show"), ("sprint-ctl", "show"),
                                ("exec-ctl", "show"), ("req-ctl", "query")):
            with self.subTest(tool=tool):
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute(tool, json.dumps({"operation": operation}).encode(), self.settings)
                self.assertEqual(captured.exception.exit_code, 3)
                self.assertIn("project_config", str(captured.exception))
                self.assertEqual(self.calls(), [])

    def test_wrong_project_identity_is_rejected_before_backend_call(self) -> None:
        legacy = self.root / "profile/erp/project.json"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('{"project":"foreign-project"}', encoding="utf-8")
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["project_config"] = os.path.relpath(legacy, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        for tool, operation in (("task-ctl", "show"), ("sprint-ctl", "show"),
                                ("exec-ctl", "show"), ("req-ctl", "query")):
            with self.subTest(tool=tool):
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute(tool, json.dumps({"operation": operation}).encode(), self.settings)
                self.assertEqual(captured.exception.exit_code, 3)
                self.assertIn("project_config", str(captured.exception))
                self.assertEqual(self.calls(), [])

    def test_other_manifest_is_rejected_before_any_backend_call(self) -> None:
        other = self.root / "other-project.json"
        for project in ("ai-poise", "another-project", "other", None, 42):
            other.write_text(json.dumps({"project": project}), encoding="utf-8")
            settings = json.loads(self.settings.read_text(encoding="utf-8"))
            settings["project_config"] = os.path.relpath(other, self.settings.parent)
            self.settings.write_text(json.dumps(settings), encoding="utf-8")
            for tool, operation in (("task-ctl", "show"), ("sprint-ctl", "show"),
                                    ("exec-ctl", "show"), ("req-ctl", "query")):
                with self.subTest(project=project, tool=tool):
                    with self.assertRaises(self.proxy.ProxyError) as captured:
                        self.proxy.execute(tool, json.dumps({"operation": operation}).encode(), self.settings)
                    self.assertEqual(captured.exception.exit_code, 3)
                    self.assertIn("project_config", str(captured.exception))
                    self.assertEqual(self.calls(), [])

    def test_launcher_symlink_uses_the_validated_installation_root(self) -> None:
        self.launcher.write_text(
            '#!/usr/bin/env bash\nprintf "%s" "${BASH_SOURCE[0]}"\n', encoding="utf-8")
        alias_directory = self.root / "launcher-alias"
        alias_directory.mkdir()
        alias = alias_directory / "erp.sh"
        alias.symlink_to(self.launcher)
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["launcher"] = os.path.relpath(alias, self.settings.parent)
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.stdout, str(self.launcher.resolve()).encode())

    def test_conflicting_or_blank_native_identity_is_rejected(self) -> None:
        for changes in ({"CODEX_SESSION_ID": "another-actor"}, {"CODEX_SESSION_ID": " "},
                        {"CODEX_THREAD_ID": " "}, {"POISE_CALLER_BINDING": "/foreign/caller"}):
            with self.subTest(changes=changes), patch.dict(os.environ, changes):
                with self.assertRaises(self.proxy.ProxyError) as captured:
                    self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
                self.assertEqual(captured.exception.exit_code, 3)
                self.assertEqual(self.calls(), [])

    def test_paths_with_spaces_are_single_arguments(self) -> None:
        spaced = self.root / "poise instance"
        spaced.mkdir()
        launcher = spaced / "poise launch.sh"
        shutil.copy2(self.launcher, launcher)
        project = spaced / "projects/erp/config/project.json"
        project.parent.mkdir(parents=True)
        shutil.copy2(self.project, project)
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings.update({
            "launcher": os.path.relpath(launcher, self.settings.parent),
            "working_directory": os.path.relpath(spaced, self.settings.parent),
            "project_config": os.path.relpath(project, self.settings.parent),
        })
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        result = self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            self.calls(),
            [[str(spaced), "actor-123", "", "work"]],
        )

    def test_native_identity_is_not_invented(self) -> None:
        with patch.dict(os.environ, {"CODEX_THREAD_ID": ""}):
            with self.assertRaises(self.proxy.ProxyError) as captured:
                self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(captured.exception.exit_code, 3)
        self.assertEqual(self.calls(), [])

    def test_both_native_aliases_missing_are_rejected(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(self.proxy.ProxyError) as captured:
                self.proxy.execute("task-ctl", b'{"operation":"show"}', self.settings)
        self.assertEqual(captured.exception.exit_code, 3)
        self.assertEqual(self.calls(), [])

    def test_nonempty_messages_are_forwarded_unchanged(self) -> None:
        packet = (
            '{ "operation": "show", "input": {}, '
            '"messages": [{"conversation_id": "actor-123", "message_id": "m1", '
            '"occurred_at": null, "reason": null, "subject": "тест"}] }\n'
        ).encode("utf-8")
        result = self.proxy.execute("task-ctl", packet, self.settings)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, packet)
        self.assertEqual(self.calls()[0][3], "work")

    def test_four_application_commands_execute_the_selected_backend(self) -> None:
        sandbox = self.root / "checkout with spaces"
        sandbox.mkdir()
        component = sandbox / "task-management"
        shutil.copytree(WRAPPER_ROOT, component,
                        ignore=shutil.ignore_patterns(".venv", "tests", "__pycache__", ".env", "settings.json"))
        environment_config = component / ".env"
        environment_config.write_text(
            f"TASK_MANAGEMENT_PYTHON={shlex.quote(sys.executable)}\n"
            f"TASK_MANAGEMENT_PYTHON_IDENTITY={shlex.quote(platform.python_implementation() + ' ' + platform.python_version())}\n"
            f"TASK_MANAGEMENT_SETTINGS={shlex.quote(str(self.settings))}\n", encoding="utf-8",
        )
        echo_launcher = self.launcher.read_text(encoding="utf-8")
        fresh_environment = dict(os.environ)
        for name in ("TASK_MANAGEMENT_SETTINGS", "TASK_MANAGEMENT_PYTHON",
                     "TASK_MANAGEMENT_PYTHON_IDENTITY", "TASK_MANAGEMENT_BIN_DIR"):
            fresh_environment.pop(name, None)
        for tool, operation in (
            ("task-ctl", "task"), ("sprint-ctl", "sprint"),
            ("req-ctl", "query"), ("exec-ctl", "advance"),
        ):
            with self.subTest(tool=tool):
                self.launcher.write_text(echo_launcher, encoding="utf-8")
                self.clear_calls()
                messages = "" if tool == "req-ctl" else ',"messages":[]'
                packet = f'{{"operation":"{operation}","input":{{}}{messages}}}\n'.encode()
                command = ["bash", str(component / tool)]
                result = subprocess.run(command, input=packet, cwd=sandbox,
                                        env=fresh_environment, capture_output=True, check=False)
                expected_args = (
                    ["requirements", "--config", str(self.project)]
                    if tool == "req-ctl"
                    else ["work"]
                )
                with self.subTest(tool=tool, outcome="success"):
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                    self.assertEqual(result.stdout, packet)
                    self.assertEqual(result.stderr, b"")
                    self.assertEqual(self.calls(),
                                     [[str(sandbox if tool == "req-ctl" else self.root),
                                       "actor-123", "", *expected_args]])

                selected = sandbox / "selected backend.json"
                selected_values = json.loads(self.settings.read_bytes())
                selected_values.update({
                    "launcher": os.path.relpath(self.launcher, selected.parent),
                    "working_directory": ".",
                    "project_config": os.path.relpath(self.project, selected.parent),
                })
                selected.write_text(json.dumps(selected_values), encoding="utf-8")
                self.clear_calls()
                explicitly_selected = subprocess.run(
                    [*command, "--config", os.path.relpath(selected, component)],
                    input=packet, cwd=self.root, env=fresh_environment, capture_output=True, check=False,
                )
                with self.subTest(tool=tool, outcome="explicit-relative-selection"):
                    self.assertEqual((explicitly_selected.returncode, explicitly_selected.stdout,
                                      explicitly_selected.stderr), (0, packet, b""))
                    self.assertEqual(self.calls(), [[str(self.root if tool == "req-ctl" else sandbox),
                                                     "actor-123", "", *expected_args]])

                self.launcher.write_text(
                    '#!/usr/bin/env bash\nprintf "backend output\\n"\n'
                    'printf "backend error\\n" >&2\nexit 7\n', encoding="utf-8",
                )
                failed = subprocess.run(command, input=packet, cwd=sandbox,
                                        env=fresh_environment, capture_output=True, check=False)
                with self.subTest(tool=tool, outcome="nonzero"):
                    self.assertEqual((failed.returncode, failed.stdout, failed.stderr),
                                     (7, b"backend output\n", b"backend error\n"))

                self.launcher.write_text(
                    '#!/usr/bin/env bash\nprintf \'%s\\n\' '
                    '\'{"status":"rejected","reason":"Stale or changed hook binding"}\'\nexit 2\n',
                    encoding="utf-8",
                )
                rejected = subprocess.run(command, input=packet, cwd=sandbox,
                                          env=fresh_environment, capture_output=True, check=False)
                with self.subTest(tool=tool, outcome="binding-rejection"):
                    self.assertEqual(
                        (rejected.returncode, rejected.stdout, rejected.stderr),
                        (2, b'{"status":"rejected","reason":"Stale or changed hook binding"}\n', b""),
                    )

                self.launcher.write_text('#!/usr/bin/env bash\nkill -TERM "$$"\n', encoding="utf-8")
                signalled = subprocess.run(command, input=packet, cwd=sandbox,
                                           env=fresh_environment, capture_output=True, check=False)
                with self.subTest(tool=tool, outcome="signal"):
                    self.assertEqual((signalled.returncode, signalled.stdout, signalled.stderr),
                                     (143, b"", b""))

                self.launcher.write_text(echo_launcher, encoding="utf-8")
                self.clear_calls()
                unknown = subprocess.run(
                    command, input=b'{"operation":"not_registered","input":{}}',
                    cwd=sandbox, env=fresh_environment, capture_output=True, check=False,
                )
                with self.subTest(tool=tool, outcome="local-rejection"):
                    self.assertEqual(unknown.returncode, 2)
                    self.assertEqual(unknown.stdout, b"")
                    self.assertIn(f"{tool}:".encode(), unknown.stderr)
                    self.assertIn(b"not_registered", unknown.stderr)
                    self.assertEqual(self.calls(), [])

                config = self.settings
                valid_config = config.read_bytes()
                missing_launcher = json.loads(valid_config)
                missing_launcher["launcher"] = str(self.root / "missing-erp.sh")
                missing_binding = json.loads(valid_config)
                missing_binding.pop("launcher")
                for failure, invalid_config in (
                    ("missing-config", None),
                    ("malformed-config", b"{"),
                    ("duplicate-config-key", valid_config[:-1] + b',"backend":"poise"}'),
                    ("missing-launcher", json.dumps(missing_launcher).encode()),
                    ("missing-binding", json.dumps(missing_binding).encode()),
                ):
                    with self.subTest(tool=tool, outcome=failure):
                        self.clear_calls()
                        if invalid_config is None:
                            config.unlink()
                        else:
                            config.write_bytes(invalid_config)
                        try:
                            invalid = subprocess.run(command, input=packet, cwd=sandbox,
                                                     env=fresh_environment, capture_output=True, check=False)
                        finally:
                            config.write_bytes(valid_config)
                        self.assertEqual(invalid.returncode, 3)
                        self.assertEqual(invalid.stdout, b"")
                        self.assertIn(str(config).encode(), invalid.stderr)
                        self.assertTrue(
                            "Исправьте".encode() in invalid.stderr
                            or "Создайте".encode() in invalid.stderr,
                            invalid.stderr,
                        )
                        self.assertEqual(self.calls(), [])

                prepared_environment = environment_config.read_bytes()
                for failure, content, diagnostic in (
                    ("missing-runtime-config", None, b"task-management/.env"),
                    ("missing-python", f"TASK_MANAGEMENT_SETTINGS={shlex.quote(str(self.settings))}\n",
                     b"TASK_MANAGEMENT_PYTHON"),
                    ("missing-settings-selection", f"TASK_MANAGEMENT_PYTHON={shlex.quote(sys.executable)}\n"
                     f"TASK_MANAGEMENT_PYTHON_IDENTITY={shlex.quote(platform.python_implementation() + ' ' + platform.python_version())}\n",
                     b"TASK_MANAGEMENT_SETTINGS"),
                    ("missing-selected-runtime", f"TASK_MANAGEMENT_PYTHON={shlex.quote(str(self.root / 'missing runtime'))}\n"
                     f"TASK_MANAGEMENT_PYTHON_IDENTITY={shlex.quote(platform.python_implementation() + ' ' + platform.python_version())}\n"
                     f"TASK_MANAGEMENT_SETTINGS={shlex.quote(str(self.settings))}\n", b"missing runtime"),
                    ("wrong-runtime-identity", f"TASK_MANAGEMENT_PYTHON={shlex.quote(sys.executable)}\n"
                     "TASK_MANAGEMENT_PYTHON_IDENTITY='Incorrect 0.0'\n"
                     f"TASK_MANAGEMENT_SETTINGS={shlex.quote(str(self.settings))}\n", b"TASK_MANAGEMENT_PYTHON_IDENTITY"),
                    ("malformed-runtime-config", "TASK_MANAGEMENT_PYTHON='unterminated\n", b".env"),
                ):
                    with self.subTest(tool=tool, outcome=failure):
                        self.clear_calls()
                        if content is None:
                            environment_config.unlink()
                        else:
                            environment_config.write_text(content, encoding="utf-8")
                        try:
                            unavailable = subprocess.run(command, input=packet, cwd=sandbox,
                                                         env=fresh_environment, capture_output=True, check=False)
                        finally:
                            environment_config.write_bytes(prepared_environment)
                        self.assertEqual(unavailable.returncode, 3)
                        self.assertEqual(unavailable.stdout, b"")
                        self.assertIn(diagnostic, unavailable.stderr)
                        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()

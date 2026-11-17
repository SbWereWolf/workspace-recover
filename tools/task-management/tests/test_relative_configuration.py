"""Accepted relative-client contract; protocol fixtures are not real Task evidence."""

from __future__ import annotations

import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import test_workflow_proxy as fixtures


DATA = Path(__file__).parent / "fixtures/relative-configuration"
PACKET = b'{"operation":"show","input":{},"messages":[]}\n'


class RelativeConfigurationTests(fixtures.BackendFixture):
    """requirements[1,4,5]: actual consumer, independent literal inputs and ledger."""

    def setUp(self) -> None:
        super().setUp()
        self.launcher.write_text((DATA / "backend.sh").read_text(encoding="utf-8"), encoding="utf-8")
        self.project = self.root / "relocated-project.json"
        self.project.write_text('{"project":"erp"}', encoding="utf-8")
        self.settings = self.root / "selection/settings.json"
        self.settings.parent.mkdir()
        self.settings.write_bytes((DATA / "settings.json").read_bytes())
        self.elsewhere = self.root / "unrelated caller"
        self.elsewhere.mkdir()

    def invoke(self, arguments: list[str]) -> subprocess.CompletedProcess:
        environment = dict(os.environ, TASK_MANAGEMENT_SETTINGS=str(self.settings))
        return subprocess.run(
            fixtures.WorkflowProxyTests.command(self, "task-ctl", arguments),
            input=PACKET, capture_output=True, cwd=self.elsewhere, env=environment, check=False,
        )

    def expected_calls(self, working_directory: Path) -> list[list[str]]:
        return [[str(working_directory), "actor-123", "", str(self.project), "work"]]

    def test_relative_fields_use_settings_directory_and_explicit_relocated_manifest(self) -> None:
        result = self.invoke([])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PACKET, b""))
        self.assertEqual(self.calls(), self.expected_calls(self.root))

    def test_unknown_options_do_not_change_selected_relative_configuration(self) -> None:
        # The complete literal fixture already contains a nested unknown option.
        before = self.settings.read_bytes()
        result = self.invoke(["--config", str(self.settings)])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PACKET, b""))
        self.assertEqual(self.calls(), self.expected_calls(self.root))
        self.assertEqual(self.settings.read_bytes(), before)

    def test_project_identity_mismatch_is_explicit_and_does_not_invoke_backend(self) -> None:
        self.project.write_text('{"project":"another-project"}', encoding="utf-8")
        result = self.invoke([])
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertRegex(result.stderr.decode("utf-8"), r"\bproject_(?:id|config)\b")
        self.assertEqual(self.calls(), [])

    def test_missing_explicit_file_never_uses_valid_default(self) -> None:
        missing = self.root / "absent-selection.json"
        result = self.invoke(["--config", str(missing)])
        self.assertEqual((result.returncode, result.stdout), (3, b""))
        self.assertIn(str(missing).encode(), result.stderr)
        self.assertEqual(self.calls(), [])

    def prepare_module(self) -> Path:
        # A three-file protocol installation fixture, not another checkout or intended-use proof.
        component = self.root / "module with spaces/task-management"
        source = component / "src/task_management"
        source.mkdir(parents=True)
        for relative in ("task-ctl", "cli.sh", "src/task_management/workflow_proxy.py"):
            shutil.copyfile(fixtures.WRAPPER_ROOT / relative, component / relative)
        (component / "settings.json").write_bytes((DATA / "module-settings.json").read_bytes())
        # Runtime arrangement uses the configured interpreter, not a product-generated oracle.
        environment = (DATA / "module.example.env").read_text(encoding="utf-8")
        environment = environment.replace("@PYTHON@", shlex.quote(os.path.relpath(sys.executable, component)))
        environment = environment.replace("@IDENTITY@", shlex.quote(
            platform.python_implementation() + " " + platform.python_version()))
        (component / ".env").write_text(environment, encoding="utf-8")
        return component

    def module_command(self, component: Path, arguments: list[str]) -> subprocess.CompletedProcess:
        environment = dict(os.environ)
        for key in ("TASK_MANAGEMENT_SETTINGS", "TASK_MANAGEMENT_PYTHON", "TASK_MANAGEMENT_PYTHON_IDENTITY"):
            environment.pop(key, None)
        return subprocess.run(["bash", str(component / "task-ctl"), *arguments],
                              input=PACKET, capture_output=True, cwd=self.elsewhere,
                              env=environment, check=False)

    def test_default_module_env_resolves_python_and_settings_without_caller_cwd(self) -> None:
        component = self.prepare_module()
        result = self.module_command(component, [])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PACKET, b""))
        self.assertEqual(self.calls(), self.expected_calls(self.root))

    def test_relative_explicit_selector_has_module_base_and_preserves_backend_directory(self) -> None:
        component = self.prepare_module()
        selected = self.root / "chosen working"
        selected.mkdir()
        value = json.loads((DATA / "module-settings.json").read_text(encoding="utf-8"))
        value["working_directory"] = "../../chosen working"
        (component / "alternate.json").write_text(json.dumps(value), encoding="utf-8")
        (self.elsewhere / "alternate.json").write_text('{"schema_version":999}', encoding="utf-8")
        result = self.module_command(component, ["--config", "alternate.json"])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PACKET, b""))
        self.assertEqual(self.calls(), self.expected_calls(selected))

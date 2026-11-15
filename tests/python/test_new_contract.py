"""New Python delivery and user-corrected permission contracts."""
import json
import os
import stat
import subprocess
import tomllib
import unittest

from support import CliContract, ROOT


class PythonDeliveryContracts(unittest.TestCase):
    def test_python_distribution_declares_the_entry_and_shared_dependency(self):
        metadata = ROOT / "pyproject.toml"
        self.assertTrue(metadata.is_file(), "Missing required Python WR distribution metadata")
        project = tomllib.loads(metadata.read_text())["project"]
        self.assertEqual(project["name"], "workspace-recover")
        self.assertTrue(project["scripts"]["workspace-recover"].startswith("workspace_recover."))
        dependencies = project.get("dependencies", [])
        selected = [value for value in dependencies if value.startswith("command-execution")]
        self.assertEqual(len(selected), 1, "WR must select one explicit shared CE release")
        self.assertRegex(selected[0], r"^command-execution==\d+\.\d+\.\d+$")

    def test_npm_install_requires_an_explicit_python_interpreter(self):
        metadata = json.loads((ROOT / "package.json").read_text())
        self.assertTrue(metadata.get("scripts", {}).get("install"),
                        "Missing npm Python runtime installation contract")
        env = dict(os.environ)
        env.pop("WORKSPACE_RECOVER_PYTHON", None)
        process = subprocess.run(["npm", "run", "install", "--silent"], cwd=ROOT,
                                 env=env, capture_output=True, timeout=15, check=False)
        self.assertEqual(process.returncode, 2)
        self.assertIn(b"WORKSPACE_RECOVER_PYTHON", process.stderr)

    def test_historical_javascript_tests_remain_unchanged(self):
        process = subprocess.run(["git", "diff", "bcca491a2d62e964e5a651e36c20e6f408736519",
                                  "--", "tests/*.test.mjs"], cwd=ROOT,
                                 capture_output=True, timeout=10, check=True)
        self.assertEqual(process.stdout, b"")


class PermissionContracts(CliContract):
    def test_flow_update_keeps_existing_permissions(self):
        target = self.workspace / "shared.json"
        target.write_text("old")
        target.chmod(0o640)
        self.flow([self.write_step("replace", "shared.json", "new", existingTarget="overwrite")])
        self.assertEqual(target.read_text(), "new")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640,
                         "Updating content must preserve existing0640 permissions")

    def test_template_update_keeps_existing_permissions(self):
        template = self.document("template.json", {"schema": "workspace-recover/template/v3",
                                                   "name": "permissions", "inputs": {},
                                                   "manifest": {"value": "new"}})
        output = self.root / "rendered.json"
        output.write_text("{}")
        output.chmod(0o640)
        self.invoke("template", "render", template, "--output", output)
        self.assertEqual(json.loads(output.read_text()), {"value": "new"})
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o640,
                         "Updating public configuration must preserve existing0640 permissions")

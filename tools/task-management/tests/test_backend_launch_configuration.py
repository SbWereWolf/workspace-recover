"""Validate backend selection before dispatch, without mutating a real project."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src/task_management'


class BackendLaunchConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        spec = importlib.util.spec_from_file_location('local_backend_launcher', SOURCE / 'poise_launcher.py')
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)
        (self.root / 'backend/src/poise').mkdir(parents=True)
        for name in ('__init__.py', '__main__.py'):
            (self.root / 'backend/src/poise' / name).write_text('')
        (self.root / 'launcher.sh').write_text('exit 99')
        (self.root / 'project.json').write_text('{"project":"selected-test-project"}')
        self.settings = self.root / 'settings.json'
        self.document = {'schema_version': 3, 'backend': 'poise', 'project_id': 'selected-test-project',
            'launcher': 'launcher.sh', 'working_directory': 'backend', 'project_config': 'project.json',
            'backend_root': 'backend', 'backend_python': os.path.relpath(sys.executable, self.root),
            'backend_python_identity': 'test runtime', 'backend_module_paths': ['backend/src']}
        self.environment = patch.dict(os.environ, {
            'TASK_MANAGEMENT_SELECTED_SETTINGS': str(self.settings),
            'POISE_CONFIG': str(self.root / 'project.json')})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_wrong_runtime_identity_rejects_without_backend_execution(self):
        self.settings.write_text(json.dumps(self.document))
        with patch.object(self.launcher.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'wrong runtime\n'
            self.assertEqual(self.launcher.main(['work']), 3)
            self.assertEqual(run.call_count, 1)

    def test_missing_dependency_path_rejects_without_backend_execution(self):
        self.document['backend_module_paths'].append('absent-dependencies')
        self.settings.write_text(json.dumps(self.document))
        with patch.object(self.launcher.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'test runtime\n'
            self.assertEqual(self.launcher.main(['work']), 3)
            self.assertEqual(run.call_count, 1)

    def test_module_paths_and_literal_arguments_reach_selected_backend(self):
        (self.root / 'dependencies').mkdir()
        self.document['backend_module_paths'].append('dependencies')
        self.settings.write_text(json.dumps(self.document))
        with patch.object(self.launcher.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'test runtime\n'
            arguments = ['work', '--literal=$(touch unexpected)']
            self.assertEqual(self.launcher.main(arguments), 0)
            self.assertEqual(run.call_count, 2)
            call = run.call_args
            self.assertEqual(call.args[0][-2:], arguments)
            self.assertEqual(call.kwargs['env']['POISE_CONFIG'], str(self.root / 'project.json'))
            self.assertEqual(call.kwargs['env']['PYTHONPATH'], os.pathsep.join([
                str(self.root / 'backend/src'), str(self.root / 'dependencies')]))

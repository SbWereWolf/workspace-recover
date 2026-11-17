"""One transport implementation, independently selected project configurations."""
import json
from pathlib import Path
import os
import unittest
from unittest.mock import patch

from test_workflow_proxy import BackendFixture, WRAPPER_ROOT
import importlib.util


class ProjectParameterizationTests(BackendFixture):
    def setUp(self):
        super().setUp()
        spec = importlib.util.spec_from_file_location('parameterized_proxy', WRAPPER_ROOT / 'src/task_management/workflow_proxy.py')
        self.proxy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.proxy)
    def test_same_code_selects_each_configured_project(self):
        source = self.project.parent
        for project_id in ('workspace-recover', 'command-execution', 'environment-maintenance'):
            with self.subTest(project_id=project_id):
                selected = source / (project_id + '.json')
                selected.write_text(json.dumps({'project': project_id}))
                settings = json.loads(self.settings.read_text())
                settings.update(project_id=project_id,
                                project_config=os.path.relpath(selected, self.settings.parent))
                self.settings.write_text(json.dumps(settings))
                self.clear_calls()
                result = self.proxy.execute('task-ctl', b'{"operation":"show","messages":[]}', self.settings)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'{"operation":"show","messages":[]}')
                self.assertEqual(len(self.calls()), 1)

    def test_configured_project_mismatch_fails_without_backend(self):
        settings = json.loads(self.settings.read_text())
        settings['project_id'] = 'workspace-recover'
        self.settings.write_text(json.dumps(settings))
        with self.assertRaises(self.proxy.ProxyError):
            self.proxy.execute('task-ctl', b'{"operation":"show"}', self.settings)
        self.assertEqual(self.calls(), [])

    def test_empty_or_invalid_project_id_fails_without_backend(self):
        settings = json.loads(self.settings.read_text())
        for value in ('', ' ', None, [], 'bad\0id'):
            with self.subTest(value=value):
                self.settings.write_text(json.dumps({**settings, 'project_id': value}))
                with self.assertRaises(self.proxy.ProxyError):
                    self.proxy.execute('task-ctl', b'{"operation":"show"}', self.settings)
                self.assertEqual(self.calls(), [])

"""Contracts for WR's yoyo configuration: rebuild, replay, rollback and locking."""
import configparser
import fcntl
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = Path(sys.argv.pop(1)).resolve(strict=True)


class MigrationContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='contract-', dir=TEST_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.database = self.path / 'requirements.sqlite'
        self.configs = {}
        for kind in ('schema', 'data'):
            config = configparser.ConfigParser(defaults={'here': str(ROOT / 'docs/requirements')})
            config.read(ROOT / f'docs/requirements/yoyo-{kind}.example.ini')
            config['DEFAULT']['database'] = 'sqlite:///' + str(self.database)
            config['DEFAULT']['lock'] = str(self.path / 'requirements.lock')
            self.configs[kind] = self.path / f'{kind}.ini'
            with self.configs[kind].open('w') as stream:
                config.write(stream)

    def run_tool(self, kind, action, *extra, check=True):
        return subprocess.run(
            [sys.executable, str(ROOT / 'scripts/requirements-migrations.py'),
             '--config', str(self.configs[kind]), action, *extra],
            cwd=ROOT, text=True, capture_output=True, check=check,
        )

    def query(self, sql):
        with sqlite3.connect(self.database) as connection:
            return connection.execute(sql).fetchall()

    def build(self):
        self.run_tool('schema', 'apply')
        self.run_tool('data', 'apply')

    def test_fresh_rebuild_and_separate_poise_histories(self):
        self.build()
        self.assertEqual(self.query('PRAGMA integrity_check'), [('ok',)])
        self.assertEqual(self.query('PRAGMA foreign_key_check'), [])
        self.assertEqual(self.query('SELECT revision FROM requirements_meta'), [(3,)])
        self.assertEqual(self.query('SELECT count(*) FROM requirements'), [(7,)])
        self.assertEqual(self.query('SELECT count(*) FROM requirement_links'), [(4,)])
        self.assertEqual(self.query('SELECT count(*) FROM requirement_requests'), [(1,)])
        tables = {row[0] for row in self.query("SELECT name FROM sqlite_master WHERE type='table'")}
        for kind in ('schema', 'data'):
            for suffix in ('', '_log', '_version'):
                self.assertIn(f'_poise_requirements_{kind}{suffix}', tables)
        self.assertNotIn('_yoyo_log', tables)

    def test_repeated_apply_does_not_repeat_inserts(self):
        self.build()
        before = self.query('SELECT * FROM requirements ORDER BY id')
        for kind in ('schema', 'data'):
            result = json.loads(self.run_tool(kind, 'apply').stdout)
            self.assertEqual(result['migrations'], [])
        self.assertEqual(self.query('SELECT * FROM requirements ORDER BY id'), before)

    def test_rollback_and_reapply_preserve_original_requirements(self):
        self.build()
        original = self.query("SELECT * FROM requirements WHERE id IN ('APP-WORKSPACE-RECOVER-SNAPSHOT','SYS-PORTABLE-WORKSPACE-RECOVERY') ORDER BY id")
        self.run_tool('data', 'rollback', '--migration', '0003-requirements-registry')
        self.run_tool('data', 'rollback', '--migration', '0002-versioned-distribution')
        self.assertEqual(self.query('SELECT * FROM requirements ORDER BY id'), original)
        self.assertEqual(self.query('SELECT revision FROM requirements_meta'), [(1,)])
        self.run_tool('data', 'apply')
        self.assertEqual(self.query('SELECT count(*) FROM requirements'), [(7,)])
        self.run_tool('data', 'rollback')
        self.run_tool('schema', 'rollback')
        self.assertEqual(self.query("SELECT name FROM sqlite_master WHERE name='requirements'"), [])

    def test_foreign_lock_and_unknown_migration_refuse_mutation(self):
        self.build()
        with (self.path / 'requirements.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.run_tool('data', 'rollback', check=False).returncode, 0)
        self.assertNotEqual(self.run_tool('data', 'apply', '--migration', 'absent', check=False).returncode, 0)
        self.assertEqual(self.query('SELECT revision FROM requirements_meta'), [(3,)])

    def test_revision_selection_preserves_dependency_order(self):
        self.run_tool('schema', 'apply')
        self.run_tool('data', 'apply', '--migration', '0003-requirements-registry')
        self.assertEqual(self.query('SELECT revision FROM requirements_meta'), [(3,)])
        result = json.loads(self.run_tool('data', 'rollback', '--migration', '0002-versioned-distribution').stdout)
        self.assertEqual(result['migrations'], ['0003-requirements-registry', '0002-versioned-distribution'])
        self.assertEqual(self.query('SELECT revision FROM requirements_meta'), [(1,)])


if __name__ == '__main__':
    unittest.main()

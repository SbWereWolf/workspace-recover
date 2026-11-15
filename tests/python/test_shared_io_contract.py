"""Shared SDK public adapter checks; select installed/candidate CE explicitly."""
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from command_execution.configuration.json_file import read_json, write_json


class SharedIoContracts(unittest.TestCase):
    def test_existing_modes_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix="ce-contract-") as root:
            for mode in (0o600, 0o640, 0o644):
                with self.subTest(mode=oct(mode)):
                    target = Path(root) / str(mode)
                    target.write_text("{}")
                    target.chmod(mode)
                    write_json(target, {"new": True})
                    self.assertEqual(json.loads(target.read_text()), {"new": True})
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)

    def test_new_file_and_parent_directories_are_created(self):
        root = Path(tempfile.mkdtemp(prefix="ce-contract-new-"))
        target = root / "missing" / "parents" / "settings.json"
        previous = os.umask(0o022)
        completed = False
        try:
            try:
                write_json(target, {"created": "independent value"})
            except (ValueError, OSError) as exc:
                self.fail(f"Shared writer lacks required new-file/parent support: {exc}")
            self.assertEqual(json.loads(target.read_text()), {"created": "independent value"})
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            completed = True
        finally:
            os.umask(previous)
            # Preserve the failed candidate instead of deleting its evidence.
            if completed:
                import shutil
                shutil.rmtree(root)
            else:
                print(f"Preserved contract evidence: {root}")

    def test_invalid_serialization_preserves_previous_file_and_mode(self):
        with tempfile.TemporaryDirectory(prefix="ce-contract-invalid-") as root:
            target = Path(root) / "settings.json"
            target.write_bytes(b'{"original":true}\n')
            target.chmod(0o640)
            with self.assertRaises(ValueError):
                write_json(target, {"unsupported": object()})
            self.assertEqual(target.read_bytes(), b'{"original":true}\n')
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)

    def test_ce_reader_rejects_nonobject_root_and_duplicate_keys(self):
        with tempfile.TemporaryDirectory(prefix="ce-contract-read-") as root:
            target = Path(root) / "settings.json"
            for payload in ('[1]', 'null', '{"key":1,"key":2}'):
                with self.subTest(payload=payload):
                    target.write_text(payload)
                    with self.assertRaises(ValueError):
                        read_json(target)

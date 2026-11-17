"""Consumer JSON call paths retain typed input and complete report content."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from workspace_recover.template import load_values
from workspace_recover.reporting import build_step_report


class DecoderCallers(unittest.TestCase):
    def test_set_json_retains_nested_types(self):
        actual, provenance = load_values(json_sets=['target={"enabled":false,"items":[1,"x"]}'])
        self.assertEqual(actual, {'target': {'enabled': False, 'items': [1, 'x']}})
        self.assertEqual(provenance['target.enabled'][0]['source'], '--set-json')

    def test_json_lines_report_reads_all_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'events.jsonl'
            source.write_text('{"level":"warning"}\n{"status":"failed","error":"detail"}\n')
            answer = build_step_report({'status': 'succeeded'},
                {'profile': 'json-lines', 'source': source.name}, root / 'report', root)
            self.assertTrue(answer['short'].startswith('2 records;'))
            self.assertIn('detail', answer['medium'])
            self.assertEqual(Path(answer['fullPath']).read_bytes(), source.read_bytes())

    def test_custom_reporter_json_is_consumed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = {'short': 'ready', 'medium': 'actual command result'}
            code = 'import json;print(json.dumps(' + repr(payload) + '))'
            answer = build_step_report({'status': 'succeeded'},
                {'profile': 'custom-command', 'argv': [sys.executable, '-c', code]}, root / 'report', root)
            self.assertEqual(answer['short'], payload['short'])
            self.assertEqual(answer['medium'], payload['medium'])
            self.assertEqual(json.loads((root / 'report/primary.json').read_text()), {'status': 'succeeded'})

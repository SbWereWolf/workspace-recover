"""Exercise the shipped outer FIFO reader with a controlled broker writer.

Only setsid/broker launch is replaced. Preparation, persistence and the reader
are the actual packaged scripts. The writer observes FIFO consumption before
withholding the next fragment beyond a read slice; no target is launched.
"""
import importlib.resources
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

WRITER = r'''
import array, fcntl, json, os, pathlib, termios, time
config = json.loads(os.environ["WR_FRAMING_FIXTURE"])
trace = pathlib.Path(config["trace"])
def record(event, **values):
    with trace.open("a") as output:
        output.write(json.dumps(dict(event=event, time_ns=time.monotonic_ns(), **values)) + "\n")
time.sleep(config["initial_delay"])
for index, encoded in enumerate(config["chunks"]):
    data = bytes.fromhex(encoded)
    record("write", index=index, bytes_hex=encoded)
    assert os.write(10, data) == len(data)
    if not data.endswith(b"\n"):
        deadline = time.monotonic() + 2
        while True:
            pending = array.array("i", [0])
            fcntl.ioctl(10, termios.FIONREAD, pending, True)
            if pending[0] == 0:
                break
            assert time.monotonic() < deadline, "Reader did not consume fragment"
            time.sleep(.002)
        record("fragment_consumed", index=index)
        time.sleep(.16)
        record("withheld_after_consumption", index=index)
record("writer_finished")
'''

class DetachedReplyFraming(unittest.TestCase):
    wire = (json.dumps({"kind": "submitted", "pid": 1234, "pgid": 1234,
        "complete": False, "completion": "unobserved",
        "note": 'literal \\ and " quotes; unicode δ'},
        ensure_ascii=True).join(("  ", "  \n"))).encode("ascii")

    def run_fixture(self, name, chunks, initial_delay=0):
        with tempfile.TemporaryDirectory(prefix="wr-reply-framing-") as temporary:
            root = Path(temporary)
            bindir = root / "bin"
            bindir.mkdir()
            writer = bindir / "setsid"
            writer.write_text("#!" + sys.executable + "\n" + WRITER)
            writer.chmod(0o700)
            attempt = root / "attempt"
            attempt.mkdir()
            request = root / "input.json"
            marker = root / "target-must-not-run"
            request.write_text(json.dumps({"nonce": "a" * 32,
                "python": sys.executable,
                "invocation": {"argv": [sys.executable, "-I", "-c",
                    "from pathlib import Path;Path(" + repr(str(marker)) + ").touch()"],
                    "cwd": str(root), "env": {}},
                "options": {"mode": "detached", "environment": "inherit",
                    "session": "new", "stdout": {"kind": "discard"},
                    "stderr": {"kind": "discard"}}}))
            script = os.environ.get("WR_FRAMING_SCRIPT") or str(
                importlib.resources.files("workspace_recover").joinpath(
                    "resources/commands/wr-process.bash"))
            trace = root / "writer.jsonl"
            env = {**os.environ, "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
                   "WR_RUNTIME_PYTHON": sys.executable,
                   "WR_FRAMING_FIXTURE": json.dumps({"chunks": [x.hex() for x in chunks],
                        "initial_delay": initial_delay, "trace": str(trace)})}
            process = subprocess.Popen(["bash", "-x", script, "run",
                "--request", str(request), "--attempt", str(attempt)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                start_new_session=True)
            try:
                stdout, stderr = process.communicate(timeout=6)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
            records = [json.loads(line) for line in trace.read_text().splitlines()]
            evidence = {"case": name, "script": script, "returncode": process.returncode,
                "stdout_hex": stdout.hex(), "writer_records": records,
                "reader_trace": stderr.decode("utf-8", "replace")}
            if os.environ.get("WR_FRAMING_EVIDENCE_DIR"):
                output = Path(os.environ["WR_FRAMING_EVIDENCE_DIR"])
                output.mkdir(parents=True, exist_ok=True)
                (output / (name + ".json")).write_text(json.dumps(evidence, indent=2))
            self.assertFalse(marker.exists())
            self.assertIn(b"kill -0", stderr, "Fixture must reach a timed-out read")
            return process.returncode, stdout, records

    def test_partial_fragments_survive_multiple_read_timeouts(self):
        code, stdout, records = self.run_fixture("split",
            [self.wire[:17], self.wire[17:63], self.wire[63:]])
        self.assertEqual(code, 0)
        self.assertEqual(stdout, self.wire)
        self.assertEqual(json.loads(stdout)["kind"], "submitted")
        self.assertEqual(len([r for r in records if r["event"] == "fragment_consumed"]), 2)
        for index in (0, 1):
            consumed = next(r for r in records if r["event"] == "fragment_consumed" and r["index"] == index)
            withheld = next(r for r in records if r["event"] == "withheld_after_consumption" and r["index"] == index)
            self.assertGreaterEqual(withheld["time_ns"] - consumed["time_ns"], 140_000_000)

    def test_empty_timeouts_do_not_repeat_a_previous_fragment(self):
        code, stdout, _ = self.run_fixture("empty-timeouts", [self.wire], initial_delay=.18)
        self.assertEqual(code, 0)
        self.assertEqual(stdout, self.wire)

    def test_dead_wrapper_with_partial_reply_stays_unknown(self):
        code, stdout, records = self.run_fixture("dead-partial", [self.wire[:17]])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout), {"kind": "completion_unknown", "complete": False})
        self.assertTrue(any(r["event"] == "fragment_consumed" for r in records))

if __name__ == "__main__":
    unittest.main()

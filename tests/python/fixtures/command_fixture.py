"""Independent command-side effects used by CLI contract scenarios."""
import argparse
import os
from pathlib import Path
import sys
import time
import subprocess
import json
import signal

parser = argparse.ArgumentParser()
parser.add_argument("--write")
parser.add_argument("--content", default="fixture marker")
parser.add_argument("--stdout-hex", default="")
parser.add_argument("--stderr-hex", default="")
parser.add_argument("--print-env")
parser.add_argument("--sleep", type=float, default=0)
parser.add_argument("--exit", type=int, default=0)
parser.add_argument("--child-marker")
parser.add_argument("--write-after-sleep")
parser.add_argument("--ready-marker")
parser.add_argument("--child-ready")
parser.add_argument("--child-delay", type=float, default=1.5)
parser.add_argument("--ignore-term", action="store_true")
parser.add_argument("--term-marker")
args = parser.parse_args()
if args.ignore_term:
    def term_handler(_signal, _frame):
        if args.term_marker:
            Path(args.term_marker).write_text("TERM observed")
    signal.signal(signal.SIGTERM, term_handler)
if args.child_marker:
    subprocess.Popen([sys.executable, "-I", "-B", __file__, "--sleep", str(args.child_delay),
                      "--write-after-sleep", args.child_marker,
                      *(["--ready-marker", args.child_ready] if args.child_ready else [])])
if args.ready_marker:
    ready = Path(args.ready_marker)
    temporary = ready.with_name(ready.name + ".tmp-" + str(os.getpid()))
    temporary.write_text(json.dumps({"pid": os.getpid(), "pgid": os.getpgrp(),
                                     "ready_ns": time.monotonic_ns()}))
    os.replace(temporary, ready)
if args.write:
    Path(args.write).write_text(args.content, encoding="utf-8")
if args.print_env:
    sys.stdout.buffer.write(os.environ.get(args.print_env, "absent").encode("utf-8"))
sys.stdout.buffer.write(bytes.fromhex(args.stdout_hex))
sys.stderr.buffer.write(bytes.fromhex(args.stderr_hex))
sys.stdout.buffer.flush()
sys.stderr.buffer.flush()
time.sleep(args.sleep)
if args.write_after_sleep:
    Path(args.write_after_sleep).write_text("child survived", encoding="utf-8")
raise SystemExit(args.exit)

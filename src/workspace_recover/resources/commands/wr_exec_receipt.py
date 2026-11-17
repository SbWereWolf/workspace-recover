"""Private single-threaded direct-exec broker; Bash owns all process policy."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time


def no_operation():
    pass


def send(event, *numbers):
    line = '|'.join([nonce, event, *(str(value) for value in numbers)]) + '\n'
    fcntl.flock(9, fcntl.LOCK_EX)
    try:
        os.write(3, line.encode('ascii'))
    finally:
        fcntl.flock(9, fcntl.LOCK_UN)


with os.fdopen(8) as stream:
    request = json.load(stream)
nonce = request['nonce']
signal.signal(signal.SIGCHLD, signal.SIG_DFL)
try:
    process = subprocess.Popen(request['argv'], cwd=request['cwd'], env=request['env'],
        stdin=7, stdout=5, stderr=6, start_new_session=request['new_session'],
        shell=False, close_fds=True, preexec_fn=no_operation)
except OSError as error:
    print(str(error), file=sys.stderr)
    for fd in (5, 6, 7):
        os.close(fd)
    send('LAUNCH_FAILED', error.errno or 0)
    raise SystemExit(0)
for fd in (5, 6, 7):
    os.close(fd)
pid = process.pid
send('EXEC_OK', pid, os.getpgid(pid))
observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
if observed is None:
    send('LIVE', pid)
    observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
send('TARGET_EXIT', observed.si_code, observed.si_status)
with os.fdopen(4) as release:
    if release.readline().strip() != 'RELEASE':
        raise RuntimeError('Missing explicit child release')
code = process.wait()
expected = observed.si_status if observed.si_code == os.CLD_EXITED else -observed.si_status
if code != expected:
    raise RuntimeError('Consumed status differs from guarded status')
send('REAPED', pid)

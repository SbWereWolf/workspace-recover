"""WR supplies its own Unix commands and projects measured target receipts."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import time
import uuid
from command_execution import ProcessWorker
from .json_files import write_json
from .util import resource_path


def execute_invocation(invocation, options):
    started = time.monotonic()
    attempt = Path(tempfile.mkdtemp(prefix='wr-process-'))
    request = {'nonce': uuid.uuid4().hex, 'python': sys.executable,
               'invocation': deepcopy(invocation), 'options': deepcopy(options)}
    source = attempt / 'input.json'
    write_json(source, request)
    script = str(resource_path('commands', 'wr-process.bash'))
    prefix = ['env', 'WR_RUNTIME_PYTHON=' + sys.executable, 'bash', script]
    outer = ProcessWorker().run([*prefix, 'run', '--request', str(source), '--attempt', str(attempt)])
    if options.get('mode') == 'detached' and outer.returncode == 0:
        result = json.loads(outer.stdout)
    else:
        status = ProcessWorker().run([*prefix, 'status', '--attempt', str(attempt)])
        result = json.loads(status.stdout) if status.returncode == 0 else {
            'kind': 'completion_unknown', 'completion': 'unobserved', 'complete': False}
    if outer.returncode != 0 and not (attempt / 'events.jsonl').exists():
        raise ValueError(outer.stderr.decode('utf-8', 'replace'))
    result = {**dict(pid=None, pgid=None, exit_code=None, signal=None, timed_out=False,
                    launch_error=None), **result}
    if result['launch_error']:
        result['launch_error'].setdefault('message', 'Target exec failed: errno ' + str(result['launch_error'].get('os_code')))
    result.update(invocation=deepcopy(invocation), duration_ms=(time.monotonic() - started) * 1000,
                  attempt=str(attempt), transport={'returncode': outer.returncode,
                    'launch_error': outer.launch_error, 'errors': outer.transport_errors})
    for name in ('stdout', 'stderr'):
        sink = options.get(name, {'kind': 'bytes'})
        raw = getattr(outer, name)
        result[name] = raw if sink['kind'] == 'bytes' else deepcopy(sink)
        if sink['kind'] == 'inherit' and raw:
            stream = sys.stdout if name == 'stdout' else sys.stderr
            stream.buffer.write(raw)
            stream.buffer.flush()
    if result['kind'] == 'submitted':
        result['launch_duration_ms'] = result['duration_ms']
        result['duration_ms'] = None
    return result


def signal_process(handle, signal_name):
    if not handle.get('attempt'):
        raise ValueError('An explicit attempt receipt is required for signalling')
    script = str(resource_path('commands', 'signal.bash'))
    raw = ProcessWorker().run(['env', 'WR_RUNTIME_PYTHON=' + sys.executable,
        'bash', script, '--attempt', handle['attempt'], '--scope', handle['scope'],
        '--id', str(handle['id']), '--signal', signal_name])
    if raw.returncode != 0:
        raise ValueError(raw.stderr.decode('utf-8', 'replace'))
    return json.loads(raw.stdout)['status']

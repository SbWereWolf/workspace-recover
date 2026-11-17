"""Private JSON/argv codec; scripts select process and filesystem policy."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def records(attempt):
    request_bytes = (attempt / 'request.json').read_bytes()
    request = json.loads(request_bytes)
    raw = (attempt / 'events.jsonl').read_bytes()
    if not raw or not raw.endswith(b'\n'):
        raise ValueError('Incomplete receipt')
    events = [json.loads(line) for line in raw.splitlines()]
    previous = -1
    for event in events:
        if (event['nonce'] != request['nonce'] or
            event['request_sha256'] != hashlib.sha256(request_bytes).hexdigest() or
            type(event['sequence']) is not int or event['sequence'] <= previous):
            raise ValueError('Receipt identity or sequence mismatch')
        previous = event['sequence']
    return request, events


def status(attempt):
    try:
        request, events = records(attempt)
        by_name = {event['event']: event for event in events}
        identity = by_name.get('EXEC_OK', {})
        result = dict(pid=identity.get('pid'), pgid=identity.get('pgid'),
            exit_code=None, signal=None, complete=False, completion='unobserved',
            kind='completion_unknown', timed_out='DEADLINE' in by_name)
        if 'PROTOCOL_ERROR' in by_name:
            return result
        if 'FINISHED' in by_name:
            if 'LAUNCH_FAILED' in by_name:
                result.update(kind='launch_failed', complete=True,
                    launch_error={'os_code': by_name['LAUNCH_FAILED']['errno']})
            elif all(name in by_name for name in ('TARGET_EXIT', 'REAPED', 'BROKER_ENDED')):
                target = by_name['TARGET_EXIT']
                result.update(kind='finished', complete=True, completion='observed')
                if target['si_code'] == os.CLD_EXITED:
                    result['exit_code'] = target['si_status']
                else:
                    import signal
                    number = target['si_status']
                    result['signal'] = {'number': number, 'name': signal.Signals(number).name}
        elif 'LIVE' in by_name:
            result['kind'] = 'submitted'
        return result
    except (OSError, ValueError, KeyError, TypeError):
        return dict(kind='completion_unknown', complete=False, completion='unobserved')


def prepare(path):
    request = json.loads(Path(path).read_text())
    nonce, invocation, options = request['nonce'], request['invocation'], request['options']
    if not isinstance(nonce, str) or re.fullmatch('[0-9a-f]{32}', nonce) is None:
        raise ValueError('Invalid request nonce')
    argv, cwd, env = invocation['argv'], invocation['cwd'], invocation['env']
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or '\0' in x for x in argv) or not argv[0]:
        raise ValueError('Invalid argv')
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or '\0' in cwd:
        raise ValueError('Invalid cwd')
    if not isinstance(env, dict) or any(not isinstance(k, str) or not k or '=' in k or '\0' in k or not isinstance(v, str) or '\0' in v for k, v in env.items()):
        raise ValueError('Invalid environment')
    mode, environment, session = (options.get(key) for key in ('mode', 'environment', 'session'))
    if mode not in ('foreground', 'detached') or environment not in ('inherit', 'replace') or session not in ('inherit', 'new'):
        raise ValueError('Explicit mode, environment and session required')
    timeout = options.get('timeout')
    if timeout is not None and not isinstance(timeout, dict):
        timeout = {'milliseconds': timeout}
    timeout = timeout or {}
    milliseconds = timeout.get('milliseconds')
    scope = timeout.get('scope', 'child')
    first = timeout.get('firstSignal', 'SIGTERM')
    escalation = timeout.get('escalation') or {}
    if milliseconds is not None and (type(milliseconds) not in (int, float) or milliseconds < 0):
        raise ValueError('Invalid deadline')
    if scope not in ('child', 'group') or first not in ('SIGTERM', 'SIGKILL', 'SIGINT'):
        raise ValueError('Invalid deadline signal policy')
    if escalation and (type(escalation.get('delayMs')) not in (int, float) or escalation['delayMs'] < 0 or escalation.get('signal') not in ('SIGTERM', 'SIGKILL', 'SIGINT')):
        raise ValueError('Invalid escalation')
    sinks = [options.get(name, {'kind': 'bytes'}) for name in ('stdout', 'stderr')]
    for sink in sinks:
        if not isinstance(sink, dict) or sink.get('kind') not in ('bytes', 'discard', 'file', 'inherit'):
            raise ValueError('Invalid output sink')
        if sink['kind'] == 'file' and (not isinstance(sink.get('path'), str) or not os.path.isabs(sink['path']) or sink.get('mode') not in ('append', 'truncate')):
            raise ValueError('Invalid file sink')
    if mode == 'detached' and (milliseconds is not None or any(sink['kind'] in ('bytes', 'inherit') for sink in sinks)):
        raise ValueError('Detached invocation requires independent sinks and no foreground deadline')
    if milliseconds is not None and scope == 'group' and session != 'new':
        raise ValueError('Group deadline requires an owned new session')
    fields = [nonce, request['python'], cwd, mode, environment, session,
        '' if milliseconds is None else str(milliseconds / 1000), scope, first,
        str(escalation.get('delayMs', 0) / 1000), escalation.get('signal', '')]
    for sink in sinks:
        fields.extend([sink['kind'], sink.get('path', ''), sink.get('mode', 'truncate'), str(sink.get('new_file_mode', 0o666))])
    fields.extend([str(len(argv)), *argv, str(len(env)), *(key + '=' + value for key, value in env.items())])
    sys.stdout.buffer.write(b'\0'.join(value.encode('utf-8') for value in fields) + b'\0')


operation = sys.argv[1]
if operation == 'prepare':
    prepare(sys.argv[2])
elif operation == 'environment':
    pairs = sys.stdin.buffer.read().split(b'\0')
    print(json.dumps(dict(pair.decode('utf-8', 'surrogateescape').split('=', 1) for pair in pairs if pair)))
elif operation == 'resolved':
    request = json.loads(Path(sys.argv[2]).read_text())
    env = json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps(dict(nonce=request['nonce'], argv=request['invocation']['argv'],
        cwd=request['invocation']['cwd'], env=env, new_session=request['options']['session'] == 'new')))
elif operation in ('status', 'reply'):
    print(json.dumps(status(Path(sys.argv[2]))))
elif operation == 'handle':
    attempt = Path(sys.argv[2]); scope, identifier = sys.argv[3], int(sys.argv[4])
    request, events = records(attempt)
    if any(event['event'] == 'PROTOCOL_ERROR' for event in events):
        raise ValueError('Cannot signal through an unknown process receipt')
    identity = next(event for event in events if event['event'] == 'EXEC_OK')
    if identifier <= 0 or scope not in ('group', 'child') or identity['pgid' if scope == 'group' else 'pid'] != identifier:
        raise ValueError('Signal handle does not match explicit attempt')
    print('reaped' if any(event['event'] == 'REAPED' for event in events) else 'owned')

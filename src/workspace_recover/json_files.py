"""WR owns paths and Bash persistence; CE owns JSON transformations."""
from importlib.resources import files
from command_execution import JSONCodec, ProcessWorker


def stringify(value, indent=None, canonical=False):
    return JSONCodec('wr-json-v1').dumps(value, indent=indent, canonical=canonical)


def loads(value):
    return JSONCodec('wr-json-v1').loads(value)


def _command(name, arguments, payload=None):
    script = str(files('workspace_recover').joinpath('resources/commands', name + '.bash'))
    result = ProcessWorker().run(['bash', script, *arguments], stdin=payload)
    if result.returncode != 0 or result.launch_error or result.transport_errors:
        raise OSError(result.stderr.decode('utf-8', 'replace') or str(result.launch_error or result.transport_errors))
    return result.stdout


def read_json(path, profile='wr-json-v1', strip_bom=False):
    text = _command('read', [str(path)]).decode('utf-8')
    if strip_bom:
        text = text.removeprefix('\ufeff')
    return JSONCodec(profile).loads(text)


def write_text(path, value, new_file_mode=0o600, exclusive=False):
    payload = value.encode('utf-8') if isinstance(value, str) else value
    _command('write', [str(path), format(new_file_mode, '04o'), 'create' if exclusive else 'replace'], payload)


def write_json(path, value, profile='wr-json-v1', new_file_mode=0o600):
    payload = JSONCodec(profile).dumps(value, indent=2) + '\n'
    write_text(path, payload, new_file_mode)


def create_json(path, value, profile='wr-json-v1', new_file_mode=0o600):
    payload = JSONCodec(profile).dumps(value, indent=2) + '\n'
    write_text(path, payload, new_file_mode, exclusive=True)

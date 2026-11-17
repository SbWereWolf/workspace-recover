"""Launch the selected Poise supply through explicit project configuration."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workflow_proxy import ProxyError, _path, _read_json, load_settings


def main(arguments: list[str]) -> int:
    try:
        selected = os.environ.get('TASK_MANAGEMENT_SELECTED_SETTINGS')
        if not selected or not Path(selected).is_absolute():
            raise ProxyError('Missing absolute TASK_MANAGEMENT_SELECTED_SETTINGS; invoke a configured transport command.', 3)
        if not arguments:
            raise ProxyError('A public Poise command is required.', 2)
        settings_path = Path(selected)
        _, _, project = load_settings(settings_path)
        if Path(os.environ.get('POISE_CONFIG', '')).resolve() != project:
            raise ProxyError('POISE_CONFIG differs from the explicitly selected project_config.', 3)
        settings = _read_json(settings_path.read_bytes(), str(settings_path), 3)
        interpreter = _path(settings, settings_path, 'backend_python', directory=False).resolve()
        source = _path(settings, settings_path, 'backend_root', directory=True).resolve()
        if not os.access(interpreter, os.X_OK):
            raise ProxyError('Configured backend_python is not executable.', 3)
        if not all((source / 'src/poise' / name).is_file() for name in ('__init__.py', '__main__.py')):
            raise ProxyError('Configured backend_root does not contain the selected Poise source entry.', 3)
        expected = settings.get('backend_python_identity')
        if not isinstance(expected, str) or not expected:
            raise ProxyError('Missing backend_python_identity in selected settings.', 3)
        probe = subprocess.run([str(interpreter), '-I', '-B', '-c',
            'import platform;print(platform.python_implementation()+" "+platform.python_version())'],
            capture_output=True, check=False)
        if probe.returncode or probe.stdout.decode().strip() != expected:
            raise ProxyError('Configured backend_python does not match backend_python_identity.', 3)
        configured_paths = settings.get('backend_module_paths')
        if not isinstance(configured_paths, list) or not configured_paths:
            raise ProxyError('Missing nonempty backend_module_paths in selected settings.', 3)
        module_paths = [str(_path({'module_path': value}, settings_path, 'module_path', directory=True).resolve())
                        for value in configured_paths]
        if module_paths[0] != str(source / 'src') or len(set(module_paths)) != len(module_paths):
            raise ProxyError('backend_module_paths must start with backend_root/src and contain no duplicates.', 3)
        environment = os.environ.copy()
        environment.pop('PYTHONHOME', None)
        environment['PYTHONPATH'] = os.pathsep.join(module_paths)
        environment['PYTHONSAFEPATH'] = '1'
        environment['PYTHONNOUSERSITE'] = '1'
        result = subprocess.run([str(interpreter), '-P', '-s', '-B', '-m', 'poise', *arguments],
                                env=environment, check=False)
        return result.returncode if result.returncode >= 0 else 128 - result.returncode
    except ProxyError as error:
        print(str(error), file=sys.stderr)
        return error.exit_code
    except OSError as error:
        print(f'Cannot launch the explicitly configured Poise: {error}', file=sys.stderr)
        return 3


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

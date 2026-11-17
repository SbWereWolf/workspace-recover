"""An owner-specific preparation route cannot change another Task's command."""
import json
from pathlib import Path
import subprocess
import sys
import pytest


@pytest.mark.parametrize('owner,expected', [('selected', 'candidate'), ('other', 'original')])
def test_actual_route_preserves_owner_and_literal_arguments(tmp_path, owner, expected):
    script = Path(__file__).parents[1] / 'src/task_management/preparation_route.py'
    paths = {}
    literal = 'space $HOME $(false) ; *'
    for name in ('original', 'candidate'):
        provider = tmp_path / (name + '.json')
        provider.write_text(json.dumps(dict(parameters={}, catalog_dir='${task_root}/catalog',
            commands={'prepare': [sys.executable, '-I', '-c',
                'import json,sys;print(json.dumps(sys.argv[1:]))', name, '${worktree}', literal.replace('$', '$$')]})))
        paths[name] = str(provider)
    settings = tmp_path / 'routing.json'
    settings.write_text(json.dumps({'default_provider': paths['original'],
        'routes': [{'task_root': str(tmp_path / 'selected'), 'provider': paths['candidate']}]}))
    result = subprocess.run([sys.executable, '-I', str(script), '--configuration', str(settings),
        '--operation', 'prepare', '--task-root', str(tmp_path / owner), '--worktree', str(tmp_path / 'work tree'),
        '--project-id', 'any-project', '--base', 'revision'], capture_output=True, check=True)
    assert json.loads(result.stdout) == [expected, str(tmp_path / 'work tree'), literal]

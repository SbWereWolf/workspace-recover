"""Select a configured preparation command for an explicit Task owner."""
import argparse
import json
import os
from pathlib import Path
from string import Template


def select(configuration, operation, coordinates):
    selected = configuration['default_provider']
    for route in configuration['routes']:
        if Path(route['task_root']).resolve() == Path(coordinates['task_root']).resolve():
            selected = route['provider']
            break
    provider = json.loads(Path(selected).read_text())
    values = {**provider['parameters'], **coordinates}
    values['catalog_dir'] = Template(provider['catalog_dir']).substitute(values)
    return [Template(argument).substitute(values) for argument in provider['commands'][operation]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--configuration', required=True)
    parser.add_argument('--operation', required=True)
    for key in ('task_root', 'worktree', 'project_id', 'base'):
        parser.add_argument('--' + key.replace('_', '-'), required=True)
    args = parser.parse_args()
    configuration = json.loads(Path(args.configuration).read_text())
    coordinates = {key: getattr(args, key) for key in ('task_root', 'worktree', 'project_id', 'base')}
    command = select(configuration, args.operation, coordinates)
    os.execv(command[0], command)


if __name__ == '__main__':
    main()

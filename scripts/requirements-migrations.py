"""Run yoyo with explicit WR configuration and Poise-compatible history names."""
import argparse
import configparser
import fcntl
import json
from pathlib import Path
import shlex

from yoyo import ancestors, descendants, get_backend, read_migrations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('action', choices=('apply', 'rollback', 'mark', 'list'))
    parser.add_argument('--migration', help='Select a revision with its dependency/rollback closure.')
    args = parser.parse_args()
    config_path = args.config.resolve(strict=True)
    config = configparser.ConfigParser(defaults={'here': str(config_path.parent)})
    with config_path.open(encoding='utf-8') as stream:
        config.read_file(stream)
    settings = config['DEFAULT']
    # Require explicit fields; never select a foreign/default database or history.
    database, sources, migration_table, log_table, version_table, lock = (
        settings[key] for key in
        ('database', 'sources', 'migration_table', 'log_table', 'version_table', 'lock')
    )
    migrations = read_migrations(*shlex.split(sources))
    if args.migration:
        matching = [migration for migration in migrations if migration.id == args.migration]
        if not matching:
            parser.error('The selected migration is absent from the configured sources.')
        revision = matching[0]
        relatives = descendants if args.action == 'rollback' else ancestors
        selected = relatives(revision, migrations) | {revision}
        migrations = migrations.filter(lambda migration: migration in selected)
    with Path(lock).open('a') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backend = get_backend(database, migration_table=migration_table)
        backend.log_table = log_table
        backend.version_table = version_table
        backend.connection.execute('PRAGMA foreign_keys=ON')
        try:
            with backend.lock(timeout=float(settings['lock_seconds'])):
                if args.action == 'rollback':
                    selected = backend.to_rollback(migrations)
                    backend.rollback_migrations(selected)
                elif args.action == 'list':
                    selected = backend.to_apply(migrations)
                else:
                    selected = backend.to_apply(migrations)
                    if args.action == 'mark':
                        backend.mark_migrations(selected)
                    else:
                        backend.apply_migrations(selected)
                print(json.dumps({'action': args.action, 'migration_table': migration_table,
                                  'migrations': [migration.id for migration in selected]}))
        finally:
            backend.connection.close()


if __name__ == '__main__':
    main()

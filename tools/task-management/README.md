# Task management transport

Run Poise task commands with an explicitly selected project and installation.
Python 3.15 is required. The backend remains responsible for task ownership,
readiness, worktree preparation and operation permissions.

Copy `app.example.env` to `.env` and `settings.example.json` to `settings.json`.
Set the interpreter, backend source, project ID and project manifest for your
installation. Both working files are ignored by Git. All paths inside the JSON
are relative to that JSON file; interpreter paths in `.env` are relative to this
directory. A relative `--config` selector is also relative to this directory.
The configured project ID must match the manifest's `project` value.
The registered manifest also needs an explicit permanent `paths.task_materials`
directory for task feedback and attachments. Merge the fragment in
`examples/project-paths.example.json` into that manifest with your project-owned
path; keep the operational manifest outside Git.
`backend_module_paths` explicitly lists the selected source and serviced
dependency directories, starting with `backend_root/src`. Existing dependency
locations are selected here; the transport does not install packages or use a
different interpreter when a dependency is missing.

Read the installed backend's command help:

```bash
bash tools/task-management/exec-ctl --command work --help
```

Send a complete public Work packet, with the actual native caller identity and
`messages: []`, to `task-ctl`, `sprint-ctl` or `exec-ctl` through stdin. `req-ctl`
forwards its public requirements packet to the selected manifest. No identity is
invented. Requirements calls preserve the caller's working directory.

For public commands requiring additional settings, pass those arguments explicitly:

```bash
bash tools/task-management/exec-ctl --command next \
  --settings /absolute/path/to/project-setup.json --project your-project
```

`exec-ctl --command` preserves literal arguments and streams stdin/stdout/stderr;
the backend exit status is retained. Missing or inconsistent configuration fails
without selecting another project. The same code accepts different project
configurations through `--config`.

Preparation profiles are in `examples/workspace-recover-maintenance/` and
`examples/candidate-runtime/`. Copy the complete selected directory to an ignored
working directory, rename each `*.example.json` to `*.json`, and fill its selected
runtime, wheel paths, exact versions and SHA256 values. The runtime profile
installs into an explicitly selected existing environment and verifies installed
package files against both wheels. It does not create an environment or publish
an artifact. Configure its preparation provider through the registered project's
manifest; a copied manifest does not acquire registry authority.

For an owner-specific preparation, configure `preparation_route.py` with
`examples/preparation-routing.example.json`. An exact explicit Task root selects
its provider; other Task roots use the configured default provider. Preserve the
default provider's input copies, parameters and handler in the registered wrapper
configuration. Provider commands use the existing `${name}` template grammar;
write `$$` for a literal dollar sign. Commands execute as argv without a shell.
Keep routing files, selected profiles and all installation-specific settings
outside Git. Commit the examples and transport code.

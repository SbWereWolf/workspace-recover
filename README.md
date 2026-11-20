# workspace-recover

**Back up a project, restore it elsewhere, verify its file hashes, and run its tests.**
Use it to prepare a workspace handoff, move work to another machine, or rehearse
restoring a backup.

You describe the recovery steps in a JSON manifest: archive files, restore them,
run your verification commands, and perform any required external operations.
WR executes those steps and saves their results in a session so you can inspect
what happened and continue after a requested decision or host action.

## Install

Run in Ubuntu or Ubuntu under WSL. You need Node.js 20+ and Python 3.12+ with
`venv` and `pip`:

```bash
export WORKSPACE_RECOVER_PYTHON=/usr/bin/python3.12
npm install --global "workspace-recover@${WR_VERSION:?Select an available release}"
workspace-recover --version
```

Set `WR_VERSION` to the available release selected for your installation.
Choose your installed Python executable explicitly. npm prepares WR's private
Python environment; dependencies must be available during installation.
For installation errors, see the [troubleshooting guide](https://github.com/SbWereWolf/workspace-recover/blob/main/docs/troubleshooting.md).

## Try a backup, restore and test run

This example creates a small Python project, saves SHA-256 checksums, archives it,
restores it into another folder, checks the restored hashes, and runs its tests.
Everything stays in a temporary local directory.

```bash
wr_demo_dir="$(mktemp -d -t wr-demo-XXXXXX)"
mkdir -p "$wr_demo_dir/project"

cat > "$wr_demo_dir/project/app.py" <<'PY'
def add(a, b):
    return a + b
PY

cat > "$wr_demo_dir/project/test_app.py" <<'PY'
import unittest
from app import add

class AppTests(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(add(2, 3), 5)

    def test_negative(self):
        self.assertEqual(add(-2, -3), -5)
PY

(cd "$wr_demo_dir/project" && sha256sum app.py test_app.py) > "$wr_demo_dir/checksums.sha256"

cat > "$wr_demo_dir/recovery.json" <<'JSON'
{
  "schema": "workspace-recover/flow/v3",
  "steps": [
    {
      "id": "pack",
      "op": "archive",
      "from": "project",
      "to": "backup/project.tar.gz",
      "onError": "continue"
    },
    {
      "id": "restore",
      "op": "extract",
      "from": "backup/project.tar.gz",
      "to": "restored",
      "onError": "continue"
    },
    {
      "id": "check_hashes",
      "op": "verification",
      "cwd": "restored",
      "argv": ["sha256sum", "--check", "../checksums.sha256"],
      "onError": "continue"
    },
    {
      "id": "tests",
      "op": "verification",
      "cwd": "restored",
      "argv": ["/usr/bin/python3.12", "-m", "unittest", "-v", "test_app"],
      "onError": "continue"
    }
  ]
}
JSON

workspace-recover flow run \
  --manifest "$wr_demo_dir/recovery.json" \
  --workspace "$wr_demo_dir" \
  --session "$wr_demo_dir/session"
```

With this project, expect `"status": "COMPLETED"`, with `check_hashes` and `tests`
both `"status": "passed"`. The hash log reports `app.py: OK` and `test_app.py: OK`;
the test log reports `Ran 2 tests` and `OK`. Full stdout/stderr log paths are
included in each command result.

If a hash check or a test fails, this manifest **continues through the remaining
checks**. WR returns `COMPLETED_WITH_OBSERVATIONS`, a combined `observations`
list and per-step `results` with exit codes and log paths. Failed checks remain
visible; WR does not turn them into a successful check or decide whether your
deployment may proceed. That decision belongs to the external orchestrator.

The manifest controls error behavior through `onError`; this example explicitly
selects `continue`. Use your project's paths, Python executable and test command.
WR does not choose tests, cleanup or rollback for you.

The archive is in `backup/project.tar.gz`, the recovered project in `restored`,
and operation results/logs in `session`, all inside `$wr_demo_dir`.
To inspect the saved workflow:

```bash
workspace-recover flow status --session "$wr_demo_dir/session"
```

## Session references

Every CLI invocation prints one `Session: {"sessionId": ..., "sessionPath": ...}`
record to stderr, including failures. Save this reference. Commands that do not
have a session report `null` values; WR does not create a recovery session for
help, version, or configuration commands. stdout keeps its command-specific JSON,
text, or single-path format.

`info`, `status`, `next`, and `continue` require an explicit session ID, with
`--state-dir DIR` when using a custom store. Flow commands require the explicit
`--session DIR` shown above. WR never searches for a current or latest session.

## Learn more

- [Flow reference: operations, decisions, retries and host actions](https://github.com/SbWereWolf/workspace-recover/blob/main/docs/flow.md)
- [Backup, handoff and restore commands](https://github.com/SbWereWolf/workspace-recover/blob/main/docs/backup-and-recovery.md)
- [Templates and typed configuration values](https://github.com/SbWereWolf/workspace-recover/blob/main/docs/templates-and-manifests.md)
- [Sessions and reports](https://github.com/SbWereWolf/workspace-recover/blob/main/docs/reporting-and-sessions.md)
- [Agent instructions](https://github.com/SbWereWolf/workspace-recover/blob/main/.agents/skills/workspace-recover/SKILL.md)
- [Russian guide](https://github.com/SbWereWolf/workspace-recover/blob/main/%D0%9F%D1%80%D0%BE%D1%87%D1%82%D0%B8.%D0%9C%D0%B5%D0%BD%D1%8F.md)

---
name: workspace-recover
description: Use the standalone workspace-recover application to create verified backups, restore workspaces from handoffs, and inspect resumable session evidence.
version: 2.2.0
---

# workspace-recover

Use the public declarative CLI. Do not reproduce supported internals with ad-hoc
`curl`, manual part concatenation, `tar`, patching, or custom restore scripts.

## Operating contract

1. Reuse an existing generated template when available. Generate a template
   once;
   later runs should normally supply only placeholder values.
2. Start `backup` or `restore` and preserve the returned session ID.
3. If state is `waiting_for_input` or `waiting_for_auth`, run `next`, perform
   only
   the requested manual action, then `continue` the same session.
4. Once a plan is frozen, do not rebuild it from a modified source template. A
   later template/manifest edit creates a new plan on a new run; it does not
   invalidate the old session.
5. Treat the manifest as the exact workflow authority. Do not select tests for
   the
   author, add mutation detection, rollback, reset, cleanup, or substitute
   profiles.
6. Verification failures are advisory unless another explicit manifest step has
   hard-failure semantics. Do not roll back a successful restore because a
   verification step warned.
7. Backup completion requires provider roundtrip verification and clean-room
   restore rehearsal. The tool owns clean-room lifecycle: remove on fully green
   rehearsal, preserve on warning/failure.
8. Generated recovery manifests belong to handoff material and are consumed
   before
   payload extraction; do not require them to exist inside the backup archive.
9. Use `workspace-recover info SESSION` for evidence discovery. `short` is
   concise,
   `medium` is reporter-specific useful detail, and `full` always returns only
   the
   filesystem path to the primary record.
10. Terminal responses should repeat the session ID and at most the compact
    `More: workspace-recover info SESSION` hint rather than expanding every
    inspection command.

## Google Workspace auth

If the tool requests Google auth, follow `docs/google-workspace-oauth.md`.
Client
credentials and refresh tokens stay outside the repository, backup, and handoff.
Do not paste secrets into manifests or chat output.


## Failed sessions

Operational failures retain the session ID and the `error` information type.
Use the exact printed `More`/`Next` command, including `--state-dir` when present.
A reporter failure is not a test pass: preserve its report-error evidence and
follow the manifest's declared next step. Do not delete partial restores.
Arbitrary OS process-crash recovery during a workflow command is not guaranteed;
do not invent exactly-once execution or replay non-idempotent commands manually.


## Standalone entrypoint and edited manifests

The distribution is the entire application folder, not the parent monorepo.
Without a global bin, invoke `node APP/bin/workspace-recover.mjs`; package tests
are `node APP/scripts/check.mjs` and need no sibling application or npm install.

Restore from `--handoff` or an explicitly selected `--manifest`, never both.
A user-edited recovery manifest starts a new session; it does not invalidate old
plans. Do not modify an existing handoff attachment to defeat its recorded hash.
Runtime `${workspace}`, `${stepDir}`, `${operation}` values inside workflow are
resolved by the executor, not requested as template inputs from the operator.

`info SESSION --view full` without a type returns the session primary path only.
Do not run cleanup, parser, or recovery commands while answering an info query.
OAuth file-presence status does not establish a successful live provider request.
Commands from manifests are trusted operator actions, not sandboxed by mkdtemp.

## Batch-first input contract

Read the bundled `templates/<preset>/values.example.json` directly; no CLI
inspection roundtrip is required. Fill all placeholders in one versioned v2
values document, then pass `--values FILE --non-interactive`. Multiple values
files and `--set`/`--set-json` retain ordered provenance. Never issue one prompt
per missing key when the tool already reports the full missing/error batch.
`--interactive` is an explicit human convenience opening a single values form.
Use `next SESSION --json` for the complete batch and `continue --values FILE`.
Old/unversioned formats require a different tool release, never compatibility
rewrites. Do not override a frozen plan with new input values.

## Project operation

Use `init local` or `init google-workspace` once, with the filled bundled values
form. Ordinary project runs use `backup` with no positional template. Init keeps
machine paths in ignored `values.local.json`, not `project.json`. It never
replaces existing author configuration. `info`, `next`, and `continue` without
an ID use the nearest project's current session. Always keep the emitted ID for
cross-directory or multi-project work; there is no global "latest session" guess.

## Named actions and saved reports

Author manifests may define named actions/reporters and list action references in
workflow order. The compiler freezes explicit argv/report specifications; receivers
do not need the author's registry. Reject unsupported document versions/features
before execution, never downgrade to an older format. Reporter profiles are listed
in `docs/reporting-and-sessions.md`. Do not select reports by reading arbitrary tail
lines when a declared structured reporter exists. Full view is always a path.

The tool removes its own successful OS-temp rehearsal room, including read-only
directories, without changing a receiver's target. Failure/warning rooms are retained.
This cleanup is not an inferred application/test cleanup step.

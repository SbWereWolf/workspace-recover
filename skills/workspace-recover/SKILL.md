---
name: workspace-recover
description: Use the standalone workspace-recover application to create verified backups, restore workspaces from handoffs, and inspect resumable session evidence.
version: 1.0.1
---

# workspace-recover

Use `flow run` for new caller-owned recovery and delivery manifests. This section
is the current default contract. The legacy material below only documents the
explicit backup/restore entrypoints; do not impose its fixed rehearsal
cycle, batch forms, or restrictions on generic flow.

## Generic flow

See [operator flow documentation](../../docs/flow.md). Use `flow run` for a
caller-owned sequence. Never ask a human about an unambiguous stage. A response
to `decisionRequest` applies to that stage only. Continue the unchanged rest of
the manifest automatically. `WAITING_HOST` is serviced by the host, not the human.
Return each question ID only once and record it using flow presented. Use host-claim before a connector call; after interruption use the generated reconciliation plan, not another send. Missing future staging directories are not
missing user inputs; preceding steps may create them. No built-in application
acceptance. Do not copy product-specific test commands into the stock template.

## Backup/restore v3 entrypoints

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
The runtime requires Python>=3.11 and the exact CE dependency selected by the
Python manifest. npm installation requires WORKSPACE_RECOVER_PYTHON pointing to
an explicit Python with venv/pip and prepares APP/.venv. Only then invoke
`node APP/bin/workspace-recover.mjs` without a global bin. An independently
installed Python package supports `PYTHON -I -B -m workspace_recover`. Source
checks are `npm test` after preparing the private runtime; they need no sibling
application. Missing dependencies are installation failures, never source fallbacks.

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
inspection roundtrip is required. Fill all placeholders in one versioned v3
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
replaces existing author configuration. `info`, `status`, `next`, and `continue`
require an explicit session ID. Never discover or guess a session by directory,
project, or stored pointer. Every CLI invocation emits a `Session: ` JSON record
on stderr with `sessionId` and `sessionPath`; keep both. Commands with no session
report null values. Flow requires an explicit `--session DIR`.

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

## Handoff-first restore and local setup

Use `restore GMAIL_URL`, a local handoff, or a recovery manifest path as the
normal entrypoint. A second Drive folder argument is not required: exact artifact
IDs and folder boundaries come from the external manifest. An explicit
`--manifest edited.json` is a new authorized run, not an edit to saved evidence.

The local profile form ships at `templates/profile.values.example.json`; use
`profile create NAME --values FILE`, then `restore SOURCE --profile NAME`.
Profiles are local versioned metadata, not OAuth secret stores. Unknown versions
or unsafe project/profile identifiers must not be guessed or converted.

Read `docs/release-policy.md` before a release. Version and tag checks belong to
the actual release candidate; do not claim publication from a commit or tag.
Run `scripts/release-check.mjs --git` only in this product's own repository; never
create commits/tags in a parent application on its behalf. Without Git the check
explicitly reports `gitVerified=false`.

Local auth status and host checks do not establish live-account access. Gmail API v1 is an external API version and must never be changed
when updating workspace-recover's internal document version.


## Archive and destination safety

Preserve full paths:
never exclude required source paths or truncate names to fit ustar. Generated
recovery manifests declare pax-paths/safe-merge; do not remove those capabilities
just to use an older binary. They are format features, not document migration.

Merge must never follow a pre-existing destination symlink (including root and
ancestors). Use an exclusive, real destination path. Regular-file replacement
must not change outside hardlink aliases. Do not claim protection against a
hostile process that can concurrently rename whole open directory trees.

Linux uses /proc/self/fd directory anchors. OS-temp rooms are not security
sandboxes. Do not alter the author's test/cleanup workflow to hide an archive
failure. A failed restore preserves partial target data; a failed/warning
rehearsal preserves its room. Application acceptance requires its own declared verification commands.

## Connector host execution (v3)

Read [connector operation](../../docs/connector-execution.md). The agent runtime
may expose Drive/Gmail tools that a standalone application process cannot call. Never
claim that importing this CLI grants access to those tools or their tokens.

Use the bundled connector capability form after discovering real host actions.
Start the CLI with `--executor connector --bridge DIR`. While its process runs,
read `bridge pending`, execute every available request through authorized host
tools, and submit a single bound results document. Do not ask the user to copy
URLs or press continue when the agent can execute the operation. The same process
continues after results arrive. Use delegated mode only when the host cannot keep
the CLI process running. Stop at real permission/capability/input boundaries.

For downloads supply freshly downloaded files plus provider ID/parents; never
copy the local upload source and call that remote verification. For Gmail send
use exact to/subject/bodyFile/attachment names from the request and text/plain.
Read the sent message and download requested JSON attachments. Do not attach
source-code archives. Unknown external outcomes require reconciliation, never
a blind resend. `info --type connector --full` returns the preserved exchange
file path. Bridge operations and replies have v3 schemas and request hashes.

## Exact capture selection

Read [selection rules](../../docs/selection.md). Use source-relative include/exclude
arrays. No implicit .gitignore or dotfile filtering. Do not pass raw patterns to
archive commands; the runtime produces an exact NUL-delimited entry list. Structural
parent directories do not recursively re-include siblings. Selection inventory is
published externally and bound by hash in the recovery manifest. Verification checks
this inventory during extraction before author workflow, not as a post-test mutation
scanner. Never drop its required capability to make an older executor accept it.

## Paired archive profiles

Read [archive profiles](../../docs/archive-profiles.md). For a non-default format, the manifest author supplies both pack and unpack argv. Do not select an archive tool or format for the caller and do not invent a built-in command catalog. Freeze both commands in the recovery manifest; never substitute a different command after failure. Pass the exact generated NUL file list, not re-expanded glob strings. Bootstrap decoders must be separately transported/hash-verified, never only inside the unopened payload. External commands are trusted author code, not sandboxed; external profiles restore into new targets. The builtin TAR.GZ path retains safe merge. Inspect saved pack/unpack reports; full view is a path. Actual source inventory comparison precedes author tests; do not add post-test mutation scanning.

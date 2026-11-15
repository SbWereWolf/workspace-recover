# workspace-recover agent guide

For new workflows use the caller-owned `flow` contract below. Older entrypoint
behaviors in this guide are compatibility descriptions, not global requirements.

`workspace-recover` is a standalone application. It must remain usable when this
folder is copied into its own repository.

- Do not import files from parent applications, `ai-assistant`, Stoneweave, or
  ERP.
- The recovery runtime is Python with the exact command-execution dependency
  declared by pyproject.toml. Node only installs/launches the private Python
  environment for the npm entry. Prepare that environment before using its shim.
- Public behavior is declarative: template -> manifest -> plan -> session ->
  receipt.
- The manifest author owns workflow order. Do not invent test selection,
  rollback,
  reset, cleanup, mutation detection, or implicit fallback behavior.
- Generated recovery manifests belong to handoff material, not backup payloads.
- The legacy v3 `backup` entrypoint performs a clean-room restore rehearsal in the OS temporary
  directory. Delete the clean room only after a fully successful rehearsal;
  preserve
  it on warning/failure for investigation.
- `info --view full` returns only a filesystem path to the primary record on stdout.
- Session lookup and current-session pointers are forbidden. Require explicit legacy
  session IDs or an explicit flow directory. Every CLI result, including errors,
  reports a `Session: ` JSON reference on stderr; use null when no session exists.
- Legacy operation results print the session ID and one compact `More:` hint;
  generic flow emits its structured status and current-stage continuation.
- Google credentials live outside the repository and outside backup payloads.
- Contract tests are required for behavioral changes.
- Package tests must run without a Git repository. Verify preserved source-file
  identities separately during integration; never require Git history in runtime tests.

## Current-stage flow contract

Read [the development skill](skills/workspace-recover-development/SKILL.md)
before changing the recovery runner. For `flow`, an answer changes only the
current stage. Continue the remaining manifest without asking anything while
it is unambiguous. Temporary artifact paths may be absent or omitted; resolve
inputs at their consuming stage. Supply concrete Ubuntu commands in advice.
Product checks are manifest commands, never stock-template requirements.
The fixed v3 backup rehearsal above documents the legacy backup entrypoint;
it must not become a gate on generic flow or on all callers' workflows.

## Requirements registry

Before changing requirements, schema, migration history or registry configuration,
read [the requirements guide](docs/requirements/README.md). The working database
belongs in `docs/requirements/requirements.sqlite`; keep all schema/data migrations,
rollbacks, bootstrap SQL and configuration examples inside WR under Git. Working
configuration, database/sidecars, locks and the migration environment are ignored.
Use WR's pinned yoyo dependency through `scripts/requirements-migrations.py`, which
preserves Poise-compatible schema/data histories. Never substitute ERP requirements
or leave WR working material in ERP. Preserve genuine Task ownership and independent
review; registry rows do not prove implementation or publication.

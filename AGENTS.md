# workspace-recover agent guide

For new workflows use the caller-owned `flow` contract below. Older entrypoint
behaviors in this guide are compatibility descriptions, not global requirements.

`workspace-recover` is a standalone application. It must remain usable when this
folder is copied into its own repository.

- Do not import files from parent applications, `ai-assistant`, Stoneweave, or
  ERP.
- Runtime dependencies are Node.js built-ins only unless the product manifest
  explicitly changes that contract.
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
- `info --view full` returns only a filesystem path to the primary record.
- Every terminal CLI result prints the session ID and one compact `More:` hint.
- Google credentials live outside the repository and outside backup payloads.
- Contract tests are required for behavioral changes.

## Current-stage flow contract (1.0.0)

Read [the development skill](skills/workspace-recover-development/SKILL.md)
before changing the recovery runner. For `flow`, an answer changes only the
current stage. Continue the remaining manifest without asking anything while
it is unambiguous. Temporary artifact paths may be absent or omitted; resolve
inputs at their consuming stage. Supply concrete Ubuntu commands in advice.
Product checks are manifest commands, never stock-template requirements.
The fixed v3 backup rehearsal above documents the legacy backup entrypoint;
it must not become a gate on generic flow or on all callers' workflows.

# workspace-recover agent guide

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
- Every backup run performs a clean-room restore rehearsal in the OS temporary
  directory. Delete the clean room only after a fully successful rehearsal;
  preserve
  it on warning/failure for investigation.
- `info --view full` returns only a filesystem path to the primary record.
- Every terminal CLI result prints the session ID and one compact `More:` hint.
- Google credentials live outside the repository and outside backup payloads.
- Contract tests are required for behavioral changes.

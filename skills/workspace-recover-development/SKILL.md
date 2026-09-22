---
name: workspace-recover-development
description: Develop, debug, test, package, and deliver workspace-recover without imposing application-specific policies on callers.
---

# Development contract

## Caller agency and current-stage scope

The tool reports facts and executes caller declarations. A decision is bound to
one session, one current stage, and one observation/request ID. Never promote a
one-stage answer to global policy. After resolving that stage, continue all
remaining unambiguous stages exactly as declared in the manifest.

DO NOT ask the operator any question on an unambiguous stage. This includes
confirmation of already supplied paths, file selections, recipients, uploads,
test choices, or continuation. A pending host call, configured retry delay,
execution budget pause, or active executor lock is not a human decision.
Only a genuinely unresolved choice at the current stage produces a decision
request. Show each request ID once; record flow presented so questionNeeded becomes false durably. Return the same ID on repeated status reads.

The caller can retry, skip, replace the current action, continue after a failure,
or stop. Preserve observed failure/mismatch facts independently of that choice.
Caller-attested completion is not measured success. No implicit rollback,
cleanup, global skip, mandatory passing tests, or application-readiness verdict.

## Product isolation

Keep the runtime generic. Application test commands and reporters belong only
in the application's manifest or separate package. The stock flow template has
no executable test step: only a non-executable comment recommending automated
tests when applicable. Do not add test-count, test-framework, readiness, or
acceptance gates. Development tests of this tool are not user recovery stages.

## Deferred paths and useful advice

A folder declared in a template need not exist. A previous stage can create it,
or a tempdir stage can choose it using the OS temporary directory. Resolve
filesystem inputs when their consuming stage is reached, not while collecting
all future questions. Do not ask for a staging path when a configured or
unambiguous temporary path is available. Preserve generated artifacts until
caller-directed cleanup or verified delivery.

Recommendations should carry executable Ubuntu argv and a shell-quoted command,
or a clearly marked command template where a value is genuinely missing.
Examples: mkdir -p -- PATH; mktemp -d -t wr-artifacts-XXXXXX;
sha256sum -- FILE; tar -tf FILE; cat -- LOG;
sleep 60; node bin/workspace-recover.mjs flow run --session SESSION.
Do not shell-interpolate untrusted filenames; keep argv and presentation separate.

## Host boundary

Use the existing typed request/response bridge. The tool prepares I/O arguments;
the authorized host executes connectors and returns actual provider responses.
The host must not guess file IDs, paths, hashes, recipients, successful outcomes,
or choose a different account. Do not introduce an imaginary API to the host.
A known download/upload/send/read declaration is executed without asking again.
Claim the host call before executing it. Outgoing inputs are snapshots bound to the request. Unknown outcomes of writes are reconciled before retry; never assume a timeout
means no effect. Explicit caller retry remains a current-stage choice.

## Resilient development

Infrastructure faults must not become process ceremony blocking development.
Preserve partial evidence, diagnose narrowly, use available alternate tools,
and retry transient calls after roughly 60–120 seconds when useful. Split long
checks into bounded jobs. Do not treat one timeout as a permanent failure.
Never report a planned or interrupted test as passed. Never promise asynchronous
work that will continue after the reply. Finish/reconcile running work before
publishing the final result.

After each meaningful milestone, use the task's configured archive store and
handoff destination. Verify a fresh downloaded copy, its hash, and extraction.
A restore rehearsal or application test is performed only when appropriate to
the task declaration, not as an implicit requirement imposed by this skill on
all end users. Retain failed runs as evidence. No invented receipts.

## Implementation and release checks

Add regression coverage for stage-decision isolation; no prompt on deterministic
success/failure continuation; absent and unnamed artifact directories; deferred
inputs; shell quoting; repeated run idempotence; explicit retries; host identity;
unknown write outcomes; and separation of project policy from stock templates.
Run tests on shipped bytes. Include code, schemas, example configuration,
operator documentation, this skill, changelog, and checksums. State the tested
scope and remaining limitations. Do not claim registry publication or Git push
unless those external actions actually succeeded.

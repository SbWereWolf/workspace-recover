# Changelog

## 0.4.0 — 2026-09-22

- Native generic flow runner with stage-scoped decisions and silent deterministic continuation.
- Just-in-time input resolution and optional artifact staging directories.
- Author-owned retries and failure policies; observed failures are not global gates.
- Reused typed Google host bridge with generated connector call plans and raw-response normalization.
- Empty stock flow template; project checks are manifest commands, not runtime acceptance policy.
- Operator documentation and development skill.


## 0.3.3 — 2026-09-22

- Synchronize timeout escalation regression with real child readiness using a controlled parent clock.
- Preserve the 150 ms deadline, 250 ms escalation, SIGKILL assertion and advisory outcome.
- No production runtime, manifest format or archive behavior changes.

## 0.3.2 — 2026-09-22

- Paired versioned exec archive profiles, typed late-bound argv, explicit executable requirements.
- Separate hash-pinned decoder bootstrap transport and shared rehearsal/ordinary restore.
- Inventory verification for external formats, no fallback on command failure, saved pack/unpack reports.
- GNU PAX truncated legacy UTF-8 name fields are ignored only when a valid PAX path overrides them.
- Bounded SIGTERM/SIGKILL handling for declared command timeouts.

## 0.3.1 — exact selection and inventory

- Source-relative include/exclude with zero-level globstar, dotfiles, explicit precedence.
- Selected-files NUL list; external inventory with exact paths, bytes, modes and hashes.
- Shared restore validates inventory before author workflow; no post-test scanning.
- Fresh readback of transport sidecar as well as payload and recovery manifest.

## 0.3.0 — 2026-09-22

- Phase 034: versioned connector bridge, fixed executor routes and resumable external operations.
- Current document family v3 only; older releases retain their own v2 sessions.


## 0.2.4 — 033 Archive boundaries and PAX

- Fix WR-028-01: lossless long UTF-8 names and link targets with POSIX PAX.
- Fix WR-028-02: refuse existing destination symlinks in the root, parents and
  leaves; anchor Linux writes to directory descriptors, replace regular leaves
  atomically without truncating external hardlink aliases.
- Strict TAR/PAX lengths, numeric fields, duplicate paths and end markers;
  private random extraction spool, source/output overlap and source-change checks.
- Short writes and stream errors are handled by complete-write loops/pipeline.
- Clean-room cleanup uses descriptor-based chmod; mode-0000 directories can be
  removed by their unprivileged owner without following swapped symlinks.
- Keep advisory workflow and user cleanup semantics unchanged. Current JSON v2
  remains current; generated manifests require pax-paths and safe-merge features.
- Add 32 regressions; all 129 tests pass as root and unprivileged. Independent
  GNU tar interoperability checks compare 44 entries by content, links and modes.

## 0.2.3 — 032 Handoff-first restore

- Restore with one Gmail/local handoff or recovery-manifest locator.
- Add versioned local profiles, target inference and batch target continuation.
- Keep explicit edited manifests and frozen credential/target selection.
- Correct the direct Gmail API path to v1; current internal formats remain v2.
- Exercise real provider code with local Google protocol and PKCE callback fixtures.
- Reject unsafe locator/profile/MIME names and foreign bearer upload endpoints.
- Ship distribution and standalone Git release checks, operator docs and skill.

## 0.2.2 — 031 Declarative actions and reporting

- Compile named actions/reporters into explicit frozen workflows.
- Add TAP, JSON-lines and artifact-list reports; aggregate JUnit suites.
- Validate nested transport/plan versions and required format capabilities.
- Clean successful owned temporary rooms with restrictive directory modes.
- Isolate the standalone test runner from operator credentials/configuration.
- Keep failures/warnings and user restore targets intact.

## 0.2.1 — 030 Project Init / Minimal UX

- One-time project init, portable defaults and ignored local values.
- Nearest-project discovery and no-argument backup.
- Scoped current session; info/next/continue without copying IDs.
- Default medium view; full path only.


## 0.2.0 — 029 Batch Inputs

- Current format v2 only; versioned bundled values forms.
- Typed batch resolution, layering, CLI JSON values, provenance.
- One-form interactive mode; complete missing-input requests.
- P0 permission regressions retained.


## 0.1.2 — permission-safety bugfix

- Каталоги с ограниченными правами (`0555`, `0000` и аналогичные) во время
  extraction получают временные owner-write/search права и только после записи
  дочерних объектов возвращаются к исходному режиму, deepest-first.
- Режим `0000` больше не заменяется неявно на `0644`.
- TAR.GZ теперь сохраняет mode корня резервируемой рабочей области через запись
  `./`, поэтому target root получает тот же Unix mode.
- При ошибке extraction уже прочитанные directory modes восстанавливаются
  best-effort; partial workspace не оставляется с временно расширенными правами.
- Добавлены регрессии на все три найденных дефекта и полный backup/rehearsal/
  handoff/restore с read-only каталогами.

## 0.1.1

- Публичный standalone-интерфейс checkpoint 028.

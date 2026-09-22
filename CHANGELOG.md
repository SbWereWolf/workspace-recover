# Changelog

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

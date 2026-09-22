# Архитектура workspace-recover

## Граница приложения

`workspace-recover/` является отделяемым приложением. Parent repository может
регистрировать его тесты или ownership, но runtime приложения использует только
Node.js built-ins и собственные файлы каталога.

Основные слои:

```text
CLI
 ↓
template / session / plan
 ↓
backup + restore orchestration
 ↓
archive / workflow / reporting
 ↓
providers
 ├─ local-files
 └─ google-workspace
```

Provider-specific код не определяет backup semantics. Manifest остаётся
авторитетом порядка операций.

## Backup и restore в одном продукте

Один runtime создаёт backup и восстанавливает его. Это позволяет backup-session
сама доказать recoverability через clean-room rehearsal тем же restore core,
который позже будет использовать потребитель.

## Recovery manifest

Generated recovery manifest формируется после получения реальных remote IDs и
hashes. Он хранится в session/handoff и не помещается tool-ом внутрь backup
payload. Потребителю не нужно сначала распаковывать данные, чтобы узнать, как их
восстанавливать.

## Frozen plan

Plan — снимок уже разрешённого manifest. Изменение исходного template или
manifest
не изменяет существующий plan и не инвалидирует старую session. Новый запуск
создаёт новый plan.

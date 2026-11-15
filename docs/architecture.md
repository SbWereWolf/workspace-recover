# Архитектура workspace-recover

## Граница приложения

`workspace-recover/` является отделяемым приложением. Parent repository может
регистрировать его тесты или ownership. Исполнитель использует Python standard
library и точную зависимость `command-execution`, указанную в `pyproject.toml`.
Импортов EM, ERP и других соседних приложений нет. npm-вход использует Node только
для установки и запуска private `.venv`; операции исполняются Python-пакетом.

Основные слои:

```text
CLI
 ↓
operations → template / session / plan
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

## Shared command core

`command-execution` владеет общими JSON/text IO, атомарной записью, коллекциями
документов, профилями подстановок, подготовкой argv/cwd/env и выполнением процессов.
WR оставляет у себя порядок flow/workflow, retry/decisions, отчёты, архивы,
провайдеры и сохранённое состояние. Выбор и значения шаблонов принадлежат
`template.py`; CLI и `operations.py` используют одного владельца без обратного
импорта CLI из операций.

Профили CE сохраняют разные договоры: строгий object/duplicate-key read для CE,
WR JSON-профиль для существующих документов; Python Template для EM и отдельные
WR template/flow/workflow-подстановки. Полная WR-подстановка может сохранить тип
массива/объекта; индексы массивов и `length` разрешаются по правилам профиля.
Environment inherit/replace, foreground/detached, байты/файлы вывода и scope
timeout задаёт вызывающий код. Общая библиотека не выбирает workflow или retry.

В npm-поставке `bin/workspace-recover.mjs` запускает подготовленный private Python;
`WORKSPACE_RECOVER_PYTHON` требуется во время установки. Python wheel содержит
собственные schemas/templates и не ищет их в соседнем checkout. Объявленная точная
версия CE должна быть доступна при установке. Локальный wheelhouse — явный способ
проверки кандидата, а не доказательство публичного релиза.

Рабочие requirements DB/config и окружение миграций не являются runtime-зависимостями
WR. Их существующий документационный/миграционный набор остаётся внутри WR, под
собственными Git/npm ignore и владельцем controlled integration.

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

# Backup и recovery workflow

## Backup

`backup` выполняет:

```text
render manifest
→ freeze plan
→ create archive
→ split parts
→ upload
→ generate recovery manifest
→ fresh provider download
→ hash verification
→ clean-room restore
→ manifest workflow
→ receipts/reports
→ handoff
→ handoff readback
```

Clean room создаётся под `os.tmpdir()`. При полностью зелёном rehearsal он
удаляется. При warning или failure сохраняется, а путь попадает в receipt.

Verification failure уведомителен: успешный restore остаётся успешным restore.
Hard failure самого восстановления не маркируется как recovery-verified.

## Restore

Restore начинается с handoff либо явно выбранного файла `--manifest`. Для Google Workspace handoff — Gmail message, в
котором находятся machine-readable attachments. Tool проверяет hashes handoff,
скачивает объявленные Drive parts, собирает архив, проверяет whole hash,
восстанавливает target и исполняет точный manifest workflow.

Target не перезаписывается молча. Если target отсутствует в intent, session
переходит в `waiting_for_input`.


## Несколько резервных копий в одном хранилище

Имена загружаемых частей включают ID backup-session. Последующий запуск с тем же
шаблоном и хранилищем не перезаписывает части предыдущей копии. Каждый handoff
ссылается на собственные объекты и контрольные суммы.

Параметры provider для данных и handoff независимы, даже когда оба имеют тип
`local-files` или `google-workspace`: получатель, профиль и каталог handoff
берутся из его декларации, а не из provider архива.


## Ошибка распаковки

При ошибке распаковки сохраняется созданная рабочая область, включая частично
восстановленные файлы. Инструмент не выполняет reset/rollback или удаление этой
области. Для rehearsal записывается неуспешный receipt и путь сохранённой clean room.
Успешный rehearsal по-прежнему удаляет только собственную временную clean room.

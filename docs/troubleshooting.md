# Troubleshooting

## `waiting_for_input`

Запросите `workspace-recover next SESSION`, передайте недостающие placeholders
через `continue SESSION --set key=value`.

## `waiting_for_auth`

Выполните команду из `next`. Для Google Workspace см.
[google-workspace-oauth.md](google-workspace-oauth.md). После авторизации:

```bash
workspace-recover continue SESSION
```

## Hash mismatch

Это hard transport failure. Не обходите hash check и не собирайте parts вручную.
Смотрите:

```bash
workspace-recover info SESSION --type backup --view medium
workspace-recover info SESSION --type backup --view full
```

`full` вернёт путь к primary record.

## Verification warnings

Restore уже может быть успешен. Tool не делает rollback/reset/cleanup.
Используйте
`info SESSION --type verification` и выполняйте только те дальнейшие действия,
которые присутствуют в manifest или явно назначены оператором.

## Preserved clean room

При warning/failure rehearsal clean room не удаляется. Его путь находится в
rehearsal receipt и предназначен для расследования.


## Python runtime и установка

Установке нужен явный `WORKSPACE_RECOVER_PYTHON`, например `/usr/bin/python3.12`,
с рабочими `venv` и `pip`. Bin использует private `.venv` установленного пакета;
простое наличие Node или скопированного каталога не заменяет подготовку.
При ошибке pip проверить доступность точной CE-версии и явно выбранного индекса
либо полного локального wheelhouse. Не подменять её соседним checkout или другой
версией. Offline candidate proof не является публичной публикацией.

## Текущая сессия после смены каталога

`info`, `status`, `next` и `continue` требуют явный ID сессии. WR не ищет
сессии по каталогу, проекту или старым указателям. Используйте ID из результата
запуска: `workspace-recover info SESSION_ID --state-dir STATE_ROOT`.
Строка `Session: {"sessionId": ..., "sessionPath": ...}` в stderr каждого вызова
указывает выбранную или созданную запись. Если сессии нет, значения равны `null`.

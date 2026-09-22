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

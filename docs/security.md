# Security contract

- Google client secret и refresh token хранятся только во внешнем config
  directory.
- Manifest commands исполняются через argv с `shell=false`.
- Restore отклоняет absolute paths, `..`, unsupported special files и symlinks,
  выходящие за target root.
- Backup transport проверяется по part hashes и whole hash до restore.
- Handoff attachments имеют собственные hashes; restore проверяет их перед
  использованием.
- Tool не добавляет скрытый rollback/reset/cleanup. Такие действия допустимы
  только как явные manifest steps.
- `full` reporting не печатает raw secret-bearing output: он возвращает путь,
  доступ к которому контролирует локальная файловая система.

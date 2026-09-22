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

## Archive destination (0.2.4)

Существующие symlinks в root/предках/обычном конечном файле отвергаются.
Linux использует no-follow directory descriptors и `/proc/self/fd`; обычные
файлы заменяются новым inode, не O_TRUNC по существующему hardlink. Target и
предки должны оставаться под исключительным контролем оператора. Это не
sandbox против противника, перемещающего целые открытые каталоги или mounts.

Дополнительные границы формата и доказательства описаны в
[отчёте об исправлении](archive-boundary-fix.md). Чистая комната — каталог ОС,
не средство изоляции manifest-команд. Автоматического выбора тестов и удаления
их последствий инструмент не добавляет.

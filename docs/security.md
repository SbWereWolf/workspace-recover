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

## File permissions

Атомарное обновление JSON/text сохраняет существующие permission bits файла.
`mode` задаёт создание нового файла, а не переопределение прав существующего.
Недостающие родительские каталоги создаются. Это не обещание сохранить ACL,
owner/group и все метаданные прежнего inode.

Flow copy/merge и fallback move на другую файловую систему сохраняют права
исходного обычного файла, включая приватные и исполняемые биты. Старый target
сохраняется по действующему правилу операции; копирование не превращает0600 в0644.
Восстановление архива отдельно применяет mode из проверенного inventory.
К приватному bridge-каталогу и credential/new-file policy применяются их явные
договоры; это не глобальная команда chmod для произвольных файлов пользователя.

## Archive destination

Существующие symlinks в root/предках/обычном конечном файле отвергаются.
Linux использует no-follow directory descriptors и `/proc/self/fd`; обычные
файлы заменяются новым inode, не O_TRUNC по существующему hardlink. Target и
предки должны оставаться под исключительным контролем оператора. Это не
sandbox против противника, перемещающего целые открытые каталоги или mounts.

Границы парных команд описаны в [архивных профилях](archive-profiles.md).
Чистая комната — каталог ОС,
не средство изоляции manifest-команд. Автоматического выбора тестов и удаления
их последствий инструмент не добавляет.

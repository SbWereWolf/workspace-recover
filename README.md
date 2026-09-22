# workspace-recover

Самостоятельное приложение резервирования и восстановления рабочей области.
Папка переносится целиком: runtime-imports из родительского репозитория и соседних
приложений отсутствуют. Это исправленная ранняя поставка 0.2.2, а не сертифицированный релиз.
GitHub-адреса в package metadata задают целевые реквизиты продукта; публикация
репозитория этой поставкой не выполняется.

Для агента: [обязательный skill](skills/workspace-recover/SKILL.md).

## Запуск без установки зависимостей

Требуется Node.js 20 или новее. Проверено в Linux x86_64 с Node.js 22.16.0;
другие ОС и версии не объявлены проверенными. Все runtime-модули — Node built-ins.
PHP, Composer, Docker и Stoneweave самому инструменту не нужны. Требования команд
конкретного manifest обеспечивает оператор резервируемой системы.

```bash
node /path/to/workspace-recover/bin/workspace-recover.mjs --help
node /path/to/workspace-recover/scripts/check.mjs
```

`npm test` из каталога приложения запускает тот же собственный runner; `npm install`
не нужен. В примерах ниже `workspace-recover` обозначает bin-команду пакета; без
установки заменяйте её на `node /path/to/workspace-recover/bin/workspace-recover.mjs`.

## Пакетные входы без предварительного вызова

Готовые формы лежат в поставке: `templates/local-project/values.example.json`
и `templates/google-workspace-project/values.example.json`. Скопируйте нужный
файл, заполните все `null` одним пакетом и передайте `--values FILE`.
`template describe NAME --format json` остаётся доступен, но не обязателен.

Форматы этого выпуска — только `workspace-recover/<kind>/v2`.
Документы без версии, `/v1` и неизвестные версии отвергаются, не преобразуются.

```bash
workspace-recover backup local-project --values project.values.json --non-interactive
workspace-recover backup local-project --values shared.json --values machine.local.json --set partSizeBytes=1048576
workspace-recover backup local-project --interactive --editor /usr/bin/nano
```

`--values` повторяется; более поздний слой перекрывает ранний, объекты объединяются,
массивы заменяются. `--set key=value` и `--set-json key=JSON` перекрывают файлы.
Происхождение и история значений записываются в plan. Машинные пути и credentials
не входят в versioned проектную конфигурацию. CLI-аргументы видны ОС; секреты в них
не передаются.

Все отсутствующие и неверные значения выдаются одним пакетом, рядом сохраняются
`missing-values.json` и `input-requirements.json`. Заполните файл и выполните
один `continue SESSION --values FILE`. `--interactive` открывает весь файл одним
вызовом executable `EDITOR`/`VISUAL` либо `--editor PATH` без shell и одиночных вопросов.

## Однократная подготовка и обычная работа

```bash
cd /work/my-project
workspace-recover init local --set backupRoot=/backups/my-project --non-interactive
workspace-recover backup
workspace-recover info
```

Для Google: `init google-workspace --values setup.json`. Шаблон копируется в
`.workspace-recover/template.json`; декларация находится в
`.workspace-recover/project.json`. Изменяемые машинные значения записываются в
`.workspace-recover/values.local.json`, для которого сразу создан локальный
`.gitignore`. Если source не задан отдельно, он вычисляется от корня проекта и
остаётся корректным после перемещения каталога. `init` не перезаписывает существующую
конфигурацию. Вызов из подкаталога использует ближайшую проектную декларацию.

`info`, `next` и `continue` без ID используют текущую сессию именно данного
проекта/каталога, а не последнюю сессию другого проекта. Явный ID доступен всегда.
`info` по умолчанию показывает `medium`; `--short`/`--full` выбирают другие виды.
Полный вид по-прежнему печатает только путь.

Экспертный интерфейс `backup TEMPLATE --values FILE` сохранён. Подготовку Google
OAuth описывает [инструкция оператору](docs/google-workspace-oauth.md).

Каждый backup создаёт отдельные части, скачивает их обратно, проверяет содержимое
и выполняет восстановление по созданному recovery manifest в своей новой папке
ОС. Затем выполняет объявленный workflow и формирует handoff с внешним recovery
manifest. Манифест автоматически в payload не добавляется. Это обратимая копия
содержимого source, включая `.git/`, если он не исключён автором.

```bash
workspace-recover restore --handoff /backups/example/handoffs/SESSION --target /work/restored
workspace-recover restore --handoff GMAIL_MESSAGE_URL --drive-folder DRIVE_FOLDER_URL --target /work/restored
workspace-recover restore --manifest edited-recovery.json --target /work/restored-edited
```

Передача `--manifest` означает осознанный запуск выбранного оператором manifest.
Он копируется в новую сессию. Старые планы, манифесты и handoff не изменяются.
Тесты и cleanup исполняются в объявленном порядке, без выбора за автора.

## Сессия и доказательства

Итог сообщает `Session`, состояния операции и одну строку `More`. Для ожидания
входных данных или Google auth он сообщает конкретное следующее действие.

```bash
workspace-recover next SESSION
workspace-recover continue SESSION --set target=/work/restored
workspace-recover info SESSION
workspace-recover info SESSION --type verification --view medium
workspace-recover info SESSION --type restore --view full
```

`short` — сводка; `medium` — полезные подробности конкретного типа результата;
`full` всегда выводит **только путь** к первичной записи. Без `--type` полное
представление указывает на `session.json`. Чтение `info` не запускает команды.

## Границы поставки

Локальные backup → handoff → restore и clean-room проверки покрыты контрактами.
Прямой OAuth provider реализован, но end-to-end с реальным Google account в этой
поставке не проверен; облачные передачи артефактов разработки выполнены отдельным
авторизованным connector. Наличие файлов OAuth не является проверкой доступа.

`continue` поддерживает ожидание ввода/auth и frozen plan; автоматическое
восстановление после произвольного убийства процесса посреди команды с внешними
эффектами пока не гарантируется. В таком случае сначала изучается сохранённая
сессия, а повторное выполнение не объявляется exactly-once.

Нативный формат — JSON manifests и TAR.GZ payload. Старые ERP cumulative TAR.XZ
checkpoint не распознаются как новый формат автоматически. Чистая папка ОС
проверяет отсутствие файловой зависимости от исходного checkout, но не является
container/VM sandbox. Команды manifest исполняются с правами оператора.

## Комплект

[Workflow](docs/backup-and-recovery.md) ·
[Шаблоны и manifests](docs/templates-and-manifests.md) ·
[Отчёты](docs/reporting-and-sessions.md) ·
[OAuth](docs/google-workspace-oauth.md) ·
[Безопасность](docs/security.md) ·
[Диагностика](docs/troubleshooting.md) ·
[Skill агента](skills/workspace-recover/SKILL.md) ·
[План развития](docs/implementation-plan.md)

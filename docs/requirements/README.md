# Реестр требований workspace-recover

Реестр WR использует System → Application → Task, как ERP. Статус `current`
означает обязательность требования, а не подтверждение его реализации.

## Файлы и настройки

Рабочая БД — `docs/requirements/requirements.sqlite`, блокировка —
`docs/requirements/requirements.lock`. БД, sidecars, lock и рабочие INI исключены
из Git и npm через локальные `.gitignore` и `.npmignore`.
В Git включаются все [DDL](schema-migrations/0001.sql), [DML](data/0001-initial-data.sql),
парные `.rollback.sql`, [bootstrap](schema.sql), [зависимости](requirements.txt),
примеры конфигурации, запускатель и проверки. Файлы ERP при работе не импортируются.
Актуальная схема реестра определяется bootstrap и версионируемыми миграциями WR.

Действующий manifest Poise для WR содержит явные абсолютные пути:

| Поле `paths` | Путь относительно WR |
| --- | --- |
| `requirements_database` | `docs/requirements/requirements.sqlite` |
| `requirements_lock` | `docs/requirements/requirements.lock` |
| `requirements_schema_migrations` | `docs/requirements/schema-migrations` |
| `requirements_data_migrations` | `docs/requirements/data` |
| `requirements_schema_file` | `docs/requirements/schema.sql` |

[Пример](poise-paths.example.json) — фрагмент `paths`, не полный manifest.
Полный manifest принадлежит установке Poise: произвольная копия не заменяет его
проектную привязку. Текущий manifest:
`/home/sbwerewolf/workdata/poise-project-data/.poise-installation/projects/workspace-recover/project.json`.
Пять путей выбираются действующим manifest; сохранённые квитанции неизменяемы.

## Инструментарий и конфиги

Из корня WR в Ubuntu:

```bash
/usr/bin/python3 -m venv .tools/requirements-migrations
.tools/requirements-migrations/bin/python -m pip install -r docs/requirements/requirements.txt
cp docs/requirements/yoyo-schema.example.ini docs/requirements/yoyo-schema.ini
cp docs/requirements/yoyo-data.example.ini docs/requirements/yoyo-data.ini
```

`yoyo-migrations==9.0.0` — зависимость разработки/операторского инструментария.
Runtime WR использует Python и выбранный `command-execution`; yoyo нужен только
для обслуживания реестра и не устанавливается как его runtime-зависимость.
Примеры INI находятся в Git, рабочие INI и окружение игнорируются. `%(here)s`
разрешается относительно INI; пути чужого checkout в них не требуются.

[Запускатель](../../scripts/requirements-migrations.py) использует API yoyo,
раздельные таблицы истории/журнала/версии `_poise_requirements_schema*` и
`_poise_requirements_data*`, совместимые с Poise, внешние ключи, файловую
блокировку и lock yoyo. Обычный CLI yoyo с одним `--migration-table`
не разделяет все служебные таблицы и для этих двух историй не используется.

## Работа с требованиями

До записи читать текущую ревизию, требования и связи через Registry с manifest
WR. Обычная запись выполняется публичным владельцем Requirements из собственной
изменяемой Task. Связывать Task requirement с подходящим Application и его
System-родителем; посторонние требования ERP не подходят для допуска.
Снимок и решения Task сохраняются её владельцем. Изменение живой БД не
переписывает принятый снимок и не подтверждает приёмку или публикацию.

Для первоначального восстановления или явно разрешённой ручной работы:

```bash
.tools/requirements-migrations/bin/python scripts/requirements-migrations.py --config docs/requirements/yoyo-schema.ini apply
.tools/requirements-migrations/bin/python scripts/requirements-migrations.py --config docs/requirements/yoyo-data.ini apply
```

На новом файле создаются схема и все данные. Для существовавшей БД начальные
INSERT не повторяются: после сверки схемы и всех исходных строк допускается
`mark --migration ID` только для реально существующих миграций. Повторный
`apply` не повторяет применённые INSERT. Данные не заменяются догадкой.

Откат проверять на отдельной восстановленной БД с отдельными INI и явным путём
к проверочной БД. Пример для последней миграции в этой копии:

```bash
.tools/requirements-migrations/bin/python scripts/requirements-migrations.py --config /absolute/path/to/test-data.ini rollback --migration 0003-requirements-registry
```

Сначала откатываются зависимые миграции; полный откат — сначала data, затем
schema. Уже применённый SQL не редактируется: нужна новая миграция с точным
обратным SQL и `-- depends:`. Для изменения структуры нужны прямой/обратный
DDL и обновление `schema.sql`. Все эти файлы включаются в Git.

После записи проверить `PRAGMA integrity_check`, `PRAGMA foreign_key_check`,
ревизию, сохранность прежних строк/квитанций, воспроизведение и Registry readback.
При переносе сначала получить целостную копию под блокировкой, сверить данные,
переключить действующие настройки и проверить чтение Poise; только после успеха
удалять прежнюю БД. Claims, приёмка и история Task не меняются ради обхода gate.

## Проверка миграций

Проверять полную цепочку DDL/DML на отдельной БД, включая исходные требования,
зависимости и прямые/обратные операции. Проверка реестра не означает публикации пакета.

```bash
mkdir -p .runtime/requirements-verification
.tools/requirements-migrations/bin/python tests/requirements_migrations_test.py .runtime/requirements-verification -v
```

Проверяются восстановление, совместимые истории, повторный apply, откат/reapply,
сохранность исходных требований и отказ при чужой блокировке/неизвестной миграции.
Временные БД тест удаляет сам. Рабочую БД, конфиги и окружение не удалять.

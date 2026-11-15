# Templates и manifest

## Generator-first workflow

Template создаётся один раз:

```bash
workspace-recover template init project-backup \
  --preset google-workspace-project \
  --output ./recovery/project-backup
```

Generator создаёт `template.json` и `values.example.json`. После этого обычная
работа состоит в подстановке значений через `--values` и/или `--set`.

Template объявляет required inputs, defaults и derived values. Если input
отсутствует, tool создаёт session со статусом `waiting_for_input`, а `next`
показывает точную команду продолжения той же session.

## Manifest-authoritative workflow

Manifest определяет все post-restore действия. Пример:

```json
{
  "restore": {
    "workflow": [
      {
        "id": "acceptance",
        "type": "verification",
        "argv": ["./tools/test", "acceptance"]
      },
      {
        "id": "cleanup",
        "type": "command",
        "when": "always",
        "argv": ["./tools/cleanup-test-state"]
      }
    ]
  }
}
```

Runtime не отслеживает автоматически, что изменил тест, и не добавляет cleanup
самостоятельно. Если cleanup нужен, его объявляет автор manifest.

Потребитель restore не выбирает, какие manifest-declared verification запускать.
Чтобы изменить требования, создаётся новый запуск с изменённым
manifest/template.
Старые frozen plans остаются валидными для своих sessions.


Повторная генерация в уже существующий каталог завершается явной ошибкой, а не
перезаписывает доработанный оператором template или values. Для новой версии
шаблона используется новый каталог; обычная работа меняет только значения.

## Типы входов и отложенные значения

`inputs.<name>.type` допускает string, number, integer, boolean, array, object,
path, email, url, enum и google-drive-folder.
Несоответствие — ошибка с именем input; строка не превращается молча в число.
`--set` распознаёт числа, boolean и null, поэтому `--set partSizeBytes=67108864` передаёт
число. Массивы и объекты передаются в JSON-файле `--values`. Неизвестные значения не подставляются автоматически.

Внутри `restore.workflow` три переменные связываются только при выполнении:
`${workspace}`, `${stepDir}`, `${operation}`. Они не являются входами оператора.
В остальных разделах отсутствующий placeholder остаётся требуемым input.

Workflow валидируется целиком до первого шага: уникальные безопасные ID, типы
command/verification, argv-массив строк, when success/always, положительный
целочисленный timeoutMs. Это проверка структуры, не изменение авторского порядка.

## Явно изменённый recovery manifest

```bash
workspace-recover restore --manifest edited-recovery.json --target /work/new-target
```

`--manifest` и `--handoff` взаимоисключающие. Новый запуск фиксирует копию выбранных
байтов до ожидания target/auth; дальнейшее редактирование исходного файла на него
не влияет. Target можно объявить в `restore.target.path`; `--target` задаёт локальный
путь текущего восстановления. Оба варианта фиксируются новым планом.

Не заменяйте attachment в старом handoff: его контрольная сумма относится к прежним
байтам. Осознанно изменённый manifest передаётся непосредственно, старый handoff
остаётся воспроизводимым. Совпадение SHA256 доказывает целостность, но не авторство
или безопасность произвольных команд manifest.

## Именованные действия

Следующий фрагмент добавляется в author manifest текущего формата
`workspace-recover/manifest/v3`:

```json
{
  "actions": {
    "tests": {
      "type": "verification",
      "exec": ["node", "scripts/check.mjs"],
      "report": "test-results"
    },
    "cleanup": {
      "type": "command",
      "when": "always",
      "exec": ["node", "scripts/cleanup.mjs"]
    }
  },
  "reporters": {"test-results": {"profile": "tap"}},
  "restore": {"workflow": ["tests", "cleanup"]}
}
```

Имена — удобство автора. В зафиксированный plan и внешний recovery manifest
попадает развёрнутый workflow с конкретными `id`, `argv` и `report`. Повторное
использование action допускается с отдельным ID: `{"action":"tests","id":"tests-again"}`.
Объявление неизвестного action/reporter или одинакового ID — ошибка до исполнения.
`exec` — тот же массив аргументов без shell, не язык командной строки.

`requires.formatVersion` допускает только `2`; `requires.features` проверяет
возможности исполнителя. Другие версии форматов не читаются. Изменение исходного
manifest не инвалидирует уже зафиксированный plan.


## Запись и runtime

Для запуска npm-входа сначала подготовить private Python runtime с точной CE;
см. [установку](../README.md#install). Команды `node scripts/check.mjs` в
author workflow — явный выбор автора, а не встроенный recovery gate.

`template render --output FILE` сохраняет существующие permission bits FILE,
создаёт отсутствующих родителей и применяет creation mode только к новому файлу.
Объединение `--values`, `--set` и `--set-json` и происхождение значений остаются
частью WR, общая механика IO/подстановок находится в CE. Полная подстановка
сохраняет тип; индекс `${items.0}` обращается к элементу массива, `${items.length}`
к его длине. Будущие stage outputs разрешаются только у потребляющего этапа.

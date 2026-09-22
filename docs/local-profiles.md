# Локальные профили и восстановление по handoff

## Один раз на машине

В поставке уже есть `templates/profile.values.example.json`. Заполните копию:

```json
{
  "schema": "workspace-recover/values/v2",
  "values": {
    "workspaceRoot": "/home/operator/work",
    "googleProfile": "personal"
  }
}
```

```bash
workspace-recover profile create personal --values profile-values.json
workspace-recover profile show personal
workspace-recover profile list
```

Создаётся `~/.config/workspace-recover/profiles/personal.json`, либо файл в
`$WORKSPACE_RECOVER_CONFIG_DIR/profiles`. Это текущий формат `profile/v2`.
Профиль содержит локальный корень рабочих областей и имя credential profile;
никаких OAuth token/client значений в нём нет. Повторный `create` не перезаписывает
файл. Его можно осознанно отредактировать перед новым запуском.

Профиль `default`, если существует, подхватывается автоматически. Другой выбирается
через `--profile NAME`; отсутствующий явно указанный профиль — ошибка, не fallback.
OAuth настраивается отдельно по [инструкции оператора](google-workspace-oauth.md).

## Получателю достаточно одного указателя

```bash
workspace-recover restore "https://mail.google.com/mail/u/0/#all/1a0c71dbfb09ed40" --profile personal
workspace-recover restore ./workspace-recovery-manifest.json --target /work/restored
workspace-recover restore /backups/project/handoffs/SESSION --target /work/restored
```

Gmail-ссылка должна содержать hex API message ID. Непрозрачные UI-only строки не
угадываются и не преобразуются поиском по теме. Доступ подтверждается выбранным
OAuth account, а не фактом наличия ссылки.

Письмо содержит внешний recovery manifest, transport manifest и handoff index.
Проверяются версии и контрольные суммы, совпадение транспортных деклараций.
Местонахождение payload и ожидаемая папка Drive берутся из recovery manifest;
дополнительный `--drive-folder` нужен только для явной проверки заданной границы.
Скачать папку целиком, найти «самый новый» файл по имени или заполнить IDs вручную
не требуется. Recovery manifest не требуется внутри payload.

Каталог назначения: явный `--target`, затем `restore.target.path` из manifest,
затем `workspaceRoot` выбранного локального профиля + безопасное `project.name`
из recovery manifest. Источник credential profile: явный `--google-profile`,
затем `googleProfile` локального профиля, затем `default`.
Эти локальные bindings фиксируются для нового запуска. Авторские команды/tests
не выбираются заново; profile не содержит переключателя verification level.

Если target не определён, создаётся одна форма `missing-values.json`. Все известные
недостающие/неверные входы возвращаются одним пакетом; `continue SESSION --values FILE`
сохраняет ID. Если для чтения письма сначала нужна авторизация, инструмент честно
сообщает эту зависимость — содержимое недоступного письма не угадывается.

## Осознанное редактирование

```bash
workspace-recover restore --manifest edited-recovery.json --target /work/another
```

Выбранный файл копируется до ожидания target/auth. Изменение исходного файла не
инвалидирует старый план; новый manifest требует нового запуска. `continue` не
принимает замену уже зафиксированных входов. Полная смена source/target/profile
выполняется новым запуском, не исправлением исторических evidence.

`info` и `continue` без ID привязаны к текущему проекту/каталогу. При смене каталога
или параллельных проектах используйте напечатанный ID явно.

# Google Workspace OAuth: инструкция оператору

## Что нужно получить

`workspace-recover` использует OAuth 2.0 от имени оператора для Google Drive и
Gmail. Требуются OAuth client credentials типа **Desktop app** и один локально
сохранённый refresh token.

Инструмент запрашивает scopes:

```text
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

Полный Drive scope нужен текущему provider для чтения существующих backup files
и
записи в заданную Drive folder без отдельного Google Picker. Gmail readonly
нужен
для чтения handoff, Gmail send — для отправки handoff.

Google относит полный Drive и `gmail.readonly` к restricted scopes, а
`gmail.send` — к sensitive scope. Для локального/private use это влияет на
consent
screen и test-user настройки; публичный продукт должен отдельно пройти требуемую
Google verification/security процедуру.

Официальные справки:

- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/identity/protocols/oauth2

## Подготовка в Google Cloud Console

1. Создайте отдельный Google Cloud project или выберите существующий проект,
   предназначенный для `workspace-recover`.
2. Включите **Google Drive API** и **Gmail API**.
3. Настройте OAuth consent screen / Google Auth Platform:
   - укажите название приложения;
   - выберите Audience;
   - для режима Testing добавьте Google account оператора в Test users;
   - добавьте scopes, перечисленные выше.
4. Откройте Google Auth Platform → Clients (либо Credentials) и создайте **OAuth client ID** типа **Desktop app**.
5. Скачайте client JSON. Не добавляйте его в repository, backup или handoff.

## Куда положить client credentials

Можно передать скачанный файл непосредственно команде:

```bash
workspace-recover auth google-workspace \
  --client ~/Downloads/client_secret_....json \
  --profile default
```

Инструмент проверит JSON и скопирует credentials в:

```text
~/.config/workspace-recover/google-workspace/default/client.json
```

или, если задан `WORKSPACE_RECOVER_CONFIG_DIR`:

```text
$WORKSPACE_RECOVER_CONFIG_DIR/google-workspace/default/client.json
```

Файл создаётся с правами 0600 в POSIX. На Windows оператор отдельно ограничивает доступ ACL; автоматическая настройка ACL
инструментом не реализована и Windows-профиль не проверен. Исходный файл из Downloads после проверки
можно удалить или перенести в операторское secret storage.

## Получение refresh token

Команда `auth` поднимает временный loopback callback на `127.0.0.1`, печатает
Google authorization URL с PKCE S256 и пытается открыть браузер. Если браузер нельзя открыть
автоматически:

```bash
workspace-recover auth google-workspace \
  --client /secure/path/client.json \
  --profile default \
  --no-browser
```

Откройте напечатанный URL в браузере на той же машине, выберите account и подтвердите scopes. `--no-browser` только запрещает автоматическое открытие: callback всё равно приходит на loopback машины, запустившей команду. Браузер другой машины без настроенного проброса порта этот callback не доставит. После
callback инструмент обменивает authorization code на access/refresh token.

Token сохраняется в:

```text
~/.config/workspace-recover/google-workspace/default/token.json
```

или под `WORKSPACE_RECOVER_CONFIG_DIR`, аналогично client file. Refresh token
никогда не помещается в backup/handoff.

Проверка:

```bash
workspace-recover auth status --profile default
```

## Cloud/CI agent

В headless/cloud среде выполните browser flow один раз на доверенной локальной
машине. Перенесите `client.json` и `token.json` через secret manager или иной
авторизованный защищённый канал. Не передавайте их в чат, обычное handoff-письмо
или папку исходников. Credentials подключённого чат-коннектора не извлекаются.

Provider обновляет `token.json` после refresh; поэтому рабочий каталог должен
быть доступен для записи. Если secrets смонтированы read-only, скопируйте их в
отдельный приватный рабочий каталог оператора, не внутрь резервируемого source.
Пример для Linux с уже существующими файлами в `/run/secrets`:

```bash
umask 077
export WORKSPACE_RECOVER_CONFIG_DIR="$HOME/.config/workspace-recover"
profile="$WORKSPACE_RECOVER_CONFIG_DIR/google-workspace/default"
install -d -m 700 "$profile"
install -m 600 /run/secrets/wr-client.json "$profile/client.json"
install -m 600 /run/secrets/wr-token.json "$profile/token.json"
workspace-recover auth status --profile default
```

`install` выше — ручная подготовка с заменой файлов выбранного credential profile,
не автоматическое действие restore. При долгоживущем запуске храните обновлённый
профиль в защищённом writable volume: эфемерная копия сама в secret manager не
синхронизируется. `auth status` проверяет только наличие файлов и сообщает пути;
доступ к конкретному письму/папке подтверждается реальной provider-операцией.

Перед началом operator задаёт разрешённую папку Drive и адрес handoff. По ссылке
не выдаются права: выбранный Google account должен иметь доступ к объектам.
Автоматической установки или переноса credentials из других продуктов нет.

## Если refresh token не выдан

Инструмент намеренно запрашивает `access_type=offline` и `prompt=consent`. Если
Google всё равно не вернул refresh token, отзовите предыдущий доступ приложения
в
Google account, затем повторите authorization. Tool завершит auth ошибкой вместо
сохранения неполного credential profile.


## Срок действия, ошибки доступа и границы проверки

Для External/Testing Google выдаёт refresh token со сроком семь дней, кроме
исключения для базовых identity-scopes. Перечисленные здесь Drive/Gmail scopes
под это исключение не попадают. Перевод статуса публикации сам по себе не отменяет
требования Google к проверке приложения и не восстанавливает уже отозванный token.
Refresh token также может стать недействительным после отзыва доступа или смены
пароля при Gmail scopes. Повторная авторизация — действие оператора, не способ
обойти отказ в доступе.

При `admin_policy_enforced` требуется разрешение Workspace administrator;
при `redirect_uri_mismatch` проверьте client type и loopback redirect. Нельзя
заменять flow устаревшим OOB-копированием кода. Полный Drive scope текущего адаптера
шире доступа к одной папке: folder check ограничивает выбор файла приложением,
но не сужает выданный Google OAuth scope.

Путь пользователя, application password Gmail и service-account key не заменяют
эту пару OAuth client/token. В текущей поставке поддержан user OAuth; service-account
domain-wide delegation не реализован. Проверки с локальными transport-fixtures и
connector-assisted скачиванием не означают успешный direct OAuth end-to-end.

Инструкция сверена 22 сентября 2026 года с официальными материалами Google:

- [Installed app flow, loopback и ошибки](https://developers.google.com/identity/protocols/oauth2/native-app).
- [Срок действия refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration).
- [Классы Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
- [Классы Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Проверка данной реализации

В 0.2.3 протокольные тесты выполняют реальный код адаптера с локальными
ответами Google API: OAuth refresh, PKCE callback, resumable Drive upload,
чтение metadata/проверка folder, скачивание, Gmail send и чтение JSON attachments.
Сетевые вызовы аккаунта в этих тестах не выполняются. Реальные файлы релизов
передаются авторизованным коннектором и проверяются отдельно. Gmail API URL
использует `/gmail/v1/`, Drive — `/drive/v3/`; собственные документы — `/v2`.

[Контракт Gmail messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) ·
[Загрузка в Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

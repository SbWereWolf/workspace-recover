# План развития workspace-recover

Работа идёт пакетами. После каждого значимого результата — отдельная проверенная
резервная копия и handoff. Инструмент остаётся самостоятельным приложением без
runtime-зависимостей от резервируемых проектов.

## P0 — блокирующее исправление архиватора/восстановления — 0.1.2

Статус: реализовано и проверено; готово к внешней доставке.

- [x] Воспроизвести `0555 -> EACCES` на непривилегированном restore.
- [x] Исправить раннее применение read-only directory mode.
- [x] Сохранять mode корня workspace.
- [x] Сохранять `0000` без fallback на `0644`.
- [x] На failed extraction не оставлять известные каталоги с временно
      расширенными правами.
- [x] Добавить RED/GREEN регрессии.
- [x] Прогнать полный standalone suite.
- [x] Создать backup самой поставки, восстановить его в чистой комнате тем же
      recovery executor и сверить содержимое/права.
- [x] Собрать готовый отделяемый архив. Drive/Gmail delivery фиксируется внешним
      release receipt и не изменяет байты поставки.

До завершения P0 этапы 029+ не развиваются.

## 029 — Batch Inputs — 0.2.0

Статус: завершено; 57/57 тестов, проверенная копия 029 и handoff rebranding.

Breaking release. Только один текущий формат каждого декларативного документа;
обратной совместимости форматов нет.

- Версионированные `values` и input requirements.
- Поставляемые `values.example` для каждого preset; README прямо указывает путь.
- Повторяемые `--values`, `--set`, `--set-json` и provenance значений.
- Пакетный `waiting_for_input`: все недостающие значения выдаются сразу.
- `next --json` и non-interactive agent workflow.
- Interactive режим редактирует/заполняет один пакет значений, а не задаёт
  последовательность одиночных вопросов.

## 030 — Project Init / Minimal UX — 0.2.1

Статус: реализовано; проверка и доставка отражаются во внешнем receipt.

- `init` из preset.
- `.workspace-recover/project.*` + local values.
- Auto-discovery проекта.
- Обычные команды `backup`, `info`, `continue` без лишних аргументов.

## 031 — Declarative Actions / Reporting

- Именованные actions и компактный workflow.
- Reporter registry; `medium` определяется доменом, `full` всегда только путь.
- Строгая проверка версии всех templates/configs/manifests/plans/receipts.

## 032 — Handoff-first Restore

- `workspace-recover restore GMAIL_HANDOFF` как основной путь.
- Handoff сам разрешает recovery manifest и provider artifacts.
- Target inference/profile/auth integration.
- Offline manifest остаётся явным fallback/expert path.

## Версионирование и Git

Каждый публичный формат имеет явное поле `schema`/version. Выпуск поддерживает
только свой текущий формат; старые документы требуют соответствующей старой
версии инструмента. При переносе в отдельный Git-репозиторий каждый release commit
обязан менять версию приложения, а release commit помечается соответствующим
version tag.

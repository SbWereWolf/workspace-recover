#!/usr/bin/env bash
set -Eeuo pipefail
tool="$1"
shift
application="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
configuration="$application/.env"
if [[ ! -f "$configuration" ]]; then
  printf '%s\n' "$tool: отсутствует task-management/.env. Создайте его по task-management/app.example.env и настройте Python и конфигурацию приложения." >&2
  exit 3
fi
if ! source "$configuration" 2>/dev/null; then
  printf '%s\n' "$tool: не удалось загрузить $configuration. Исправьте синтаксис Bash по app.example.env." >&2
  exit 3
fi
if [[ -n "${TASK_MANAGEMENT_PYTHON:-}" && "$TASK_MANAGEMENT_PYTHON" != /* ]]; then
  TASK_MANAGEMENT_PYTHON="$application/$TASK_MANAGEMENT_PYTHON"
fi
if [[ -z "${TASK_MANAGEMENT_PYTHON:-}" || ! -f "$TASK_MANAGEMENT_PYTHON" || ! -x "$TASK_MANAGEMENT_PYTHON" ]]; then
  printf '%s\n' "$tool: TASK_MANAGEMENT_PYTHON недоступен: ${TASK_MANAGEMENT_PYTHON:-не задан}. Настройте путь от каталога task-management к совместимому Python в $configuration." >&2
  exit 3
fi
if [[ -z "${TASK_MANAGEMENT_PYTHON_IDENTITY:-}" ]]; then
  printf '%s\n' "$tool: отсутствует TASK_MANAGEMENT_PYTHON_IDENTITY. Задайте точную идентичность выбранного Python в $configuration." >&2
  exit 3
fi
if ! actual_identity=$("$TASK_MANAGEMENT_PYTHON" -I -B -c 'import platform,sys; sys.exit(3) if sys.version_info[:2] != (3,15) else print(platform.python_implementation()+" "+platform.python_version())' 2>/dev/null); then
  printf '%s\n' "$tool: выбранный Python не запускается или несовместим. Укажите Python 3.15.x в $configuration." >&2
  exit 3
fi
if [[ "$actual_identity" != "$TASK_MANAGEMENT_PYTHON_IDENTITY" ]]; then
  printf '%s\n' "$tool: Python не соответствует TASK_MANAGEMENT_PYTHON_IDENTITY. Согласуйте исполнитель и ожидаемую идентичность в $configuration." >&2
  exit 3
fi
export TASK_MANAGEMENT_SETTINGS
exec "$TASK_MANAGEMENT_PYTHON" -I -B "$application/src/task_management/workflow_proxy.py" "$tool" "$@"

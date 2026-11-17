#!/usr/bin/env bash
set -Eeuo pipefail
application="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$application/.env"
if [[ "$TASK_MANAGEMENT_PYTHON" != /* ]]; then
  TASK_MANAGEMENT_PYTHON="$application/$TASK_MANAGEMENT_PYTHON"
fi
exec "$TASK_MANAGEMENT_PYTHON" -I -B "$application/src/task_management/poise_launcher.py" "$@"

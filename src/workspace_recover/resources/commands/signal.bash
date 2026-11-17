#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
attempt= scope= identifier= signal=
while (($#)); do
    case $1 in
        --attempt) attempt=$2;;
        --scope) scope=$2;;
        --id) identifier=$2;;
        --signal) signal=$2;;
        *) exit 2;;
    esac
    shift 2
done
[[ $identifier =~ ^[1-9][0-9]*$ && $signal =~ ^SIG(TERM|KILL|INT|HUP|USR1|USR2)$ ]]
python=${WR_RUNTIME_PYTHON:?Explicit WR runtime required}
ownership=$("$python" -I -S -B "$directory/wr_request.py" handle "$attempt" "$scope" "$identifier")
address=$identifier
if [[ $scope == group ]]; then address=-$identifier; fi
if [[ $ownership == reaped ]]; then
    if kill -0 -- "$address" 2>/dev/null; then status=unknown; else status=absent; fi
elif kill -s "$signal" -- "$address" 2>/dev/null; then status=sent
elif kill -0 -- "$address" 2>/dev/null; then status=unknown
else status=absent
fi
printf '{"status":"%s"}\n' "$status"

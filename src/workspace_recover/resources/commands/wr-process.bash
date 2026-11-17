#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
operation=$1
shift
attempt= request=
while (($#)); do
    case $1 in
        --attempt) attempt=$2; shift 2;;
        --request) request=$2; shift 2;;
        *) exit 2;;
    esac
done
python=${WR_RUNTIME_PYTHON:?Explicit WR runtime required}
if [[ $operation == status ]]; then
    exec "$python" -I -S -B "$directory/wr_request.py" status "$attempt"
fi
[[ $operation == run && -n $request && -d $attempt ]]
"$python" -I -S -B "$directory/wr_request.py" prepare "$request" > "$attempt/request.values"
bash "$directory/write.bash" "$attempt/request.json" 0600 create < "$request"
mapfile -d '' -t fields < "$attempt/request.values"
if [[ ${fields[3]} == foreground ]]; then
    exec bash "$directory/wr-supervise.bash" "$attempt" foreground
fi
mkfifo -- "$attempt/reply"
exec 10<> "$attempt/reply"
setsid --fork --wait bash "$directory/wr-supervise.bash" "$attempt" detached \
    </dev/null >"$attempt/controller.stdout" 2>"$attempt/controller.stderr" 10>&10 &
wrapper=$!
reply=
while true; do
    fragment=
    if IFS= read -r -t 0.05 fragment <&10; then
        reply+=$fragment
        break
    fi
    # A timed-out read can consume part of the line. Keep it for the next slice.
    reply+=$fragment
    if ! kill -0 "$wrapper" 2>/dev/null; then
        wait "$wrapper" || true
        printf '%s\n' '{"kind":"completion_unknown","complete":false}'
        exit 1
    fi
done
exec 10>&-
printf '%s\n' "$reply"

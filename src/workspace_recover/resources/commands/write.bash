#!/usr/bin/env bash
set -euo pipefail
path=$1
mode=${2:-0600}
publication=${3:-replace}
parent=$(dirname -- "$path")
mkdir -p -- "$parent"
temporary=$(mktemp -- "$parent/.write.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary"
if [[ -e "$path" ]]; then
    chmod --reference="$path" -- "$temporary"
else
    chmod -- "$mode" "$temporary"
fi
if [[ "$publication" == create ]]; then
    ln -- "$temporary" "$path"
else
    mv -fT -- "$temporary" "$path"
fi

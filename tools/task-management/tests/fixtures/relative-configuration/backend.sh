#!/usr/bin/env bash
record=$(mktemp "${ERP_PROXY_TEST_LOG}.XXXXXX")
printf '%s\0' "$PWD" "${CODEX_THREAD_ID:-}" "${POISE_CALLER_BINDING:-}" "${POISE_CONFIG:-}" "$@" > "$record"
cat

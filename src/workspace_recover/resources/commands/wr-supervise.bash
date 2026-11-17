#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
attempt=$1
mode=$2
python=${WR_RUNTIME_PYTHON:?Explicit WR runtime required}
mapfile -d '' -t fields < "$attempt/request.values"
nonce=${fields[0]}
target_python=${fields[1]}
environment=${fields[4]}
deadline=${fields[6]}
scope=${fields[7]}
first_signal=${fields[8]}
grace=${fields[9]}
escalation=${fields[10]}
index=19
argc=${fields[index]}; ((index+=argc+1))
envc=${fields[index]}; ((index+=1))
envargs=("${fields[@]:index:envc}")
if [[ $environment == replace ]]; then
    env -i -- "${envargs[@]}" /usr/bin/env -0
else
    env -- "${envargs[@]}" /usr/bin/env -0
fi | "$python" -I -S -B "$directory/wr_request.py" environment > "$attempt/environment.json"
"$python" -I -S -B "$directory/wr_request.py" resolved "$attempt/request.json" "$attempt/environment.json" > "$attempt/resolved.json"
request_hash=$(sha256sum -- "$attempt/request.json"); request_hash=${request_hash%% *}
mkfifo -- "$attempt/control" "$attempt/release"
exec 3<> "$attempt/control" 4<> "$attempt/release"
: > "$attempt/control.lock"
: > "$attempt/events.jsonl"
sequence=0
record() {
    local event=$1 suffix=${2:-}
    printf '{"schema":1,"nonce":"%s","sequence":%d,"request_sha256":"%s","event":"%s"%s}\n' \
        "$nonce" "$sequence" "$request_hash" "$event" "$suffix" >> "$attempt/events.jsonl"
    ((sequence+=1))
}
bus() {
    (
        flock 9
        printf -v line '%s|' "$nonce" "$@"
        printf '%s\n' "${line%|}" >&3
    ) 9> "$attempt/control.lock"
}
collectors=()
eof_expected=0
prepare_sink() {
    local descriptor=$1 offset=$2 name=$3 kind=${fields[$2]} path=${fields[$2+1]} filemode=${fields[$2+2]} fresh=${fields[$2+3]}
    case $kind in
        bytes)
            local fifo="$attempt/$name.pipe"
            mkfifo -- "$fifo"
            (
                exec 4>&-
                if [[ $mode == detached ]]; then exec 10>&-; fi
                if [[ $name == out ]]; then cat -- "$fifo" >&1 & else cat -- "$fifo" >&2 & fi
                utility=$!
                bus OWNED_CHILD "$utility" collector-utility
                wait "$utility"
                bus REAPED_HELPER "$utility"
                bus STREAM_EOF "$name"
            ) &
            collectors+=("$!")
            record OWNED_CHILD ",\"pid\":${collectors[-1]},\"role\":\"collector\""
            eval "exec $descriptor> \"\$fifo\""
            ((eof_expected+=1))
            ;;
        discard) eval "exec $descriptor> /dev/null";;
        inherit)
            if [[ $name == out ]]; then eval "exec $descriptor>&1"; else eval "exec $descriptor>&2"; fi
            ;;
        file)
            # The caller's umask applies to a fresh file; existing modes remain.
            if [[ ! -e $path ]]; then
                (umask 000; set -o noclobber; : > "$path") 2>/dev/null || [[ -e $path ]]
                chmod -- "$(printf '%o' "$fresh")" "$path"
            fi
            if [[ $filemode == append ]]; then eval "exec $descriptor>> \"\$path\""; else eval "exec $descriptor> \"\$path\""; fi
            ;;
    esac
}
prepare_sink 5 11 out
prepare_sink 6 15 err
exec 7< /dev/null 8< "$attempt/resolved.json"
(
    if [[ $mode == detached ]]; then exec 10>&-; fi
    "$target_python" -I -S -B "$directory/wr_exec_receipt.py" \
        9> "$attempt/control.lock" 2> "$attempt/broker.stderr" &
    broker=$!
    exec 5>&- 6>&- 7<&- 8<&-
    bus OWNED_CHILD "$broker" broker
    result=0
    wait "$broker" || result=$?
    bus REAPED_HELPER "$broker"
    bus BROKER_ENDED "$result"
) &
broker_wrapper=$!
record OWNED_CHILD ",\"pid\":$broker_wrapper,\"role\":\"broker-wrapper\""
exec 5>&- 6>&- 7<&- 8<&-
watcher= grace_watcher=
start_watch() {
    local duration=$1 event=$2
    (
        exec 4>&-
        if [[ $mode == detached ]]; then exec 10>&-; fi
        sleep "$duration" &
        sleeper=$!
        bus OWNED_CHILD "$sleeper" sleep
        trap 'kill -TERM "$sleeper" 2>/dev/null || true; wait "$sleeper" 2>/dev/null || true; bus REAPED_HELPER "$sleeper"; exit 0' TERM
        wait "$sleeper"
        bus REAPED_HELPER "$sleeper"
        bus "$event"
    ) &
    last_watch=$!
    record OWNED_CHILD ",\"pid\":$last_watch,\"role\":\"${event,,}-watch\""
}
cancel_watch() {
    local child=$1
    if [[ -n $child ]]; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
        record REAPED_HELPER ",\"pid\":$child"
    fi
}
pid= pgid= broker_pid=
target_exit=0 launch_failed=0 reaped=0 ended=0 released=0 eof_count=0 timed_out=0 grace_done=1 replied=0
send_signal() {
    local name=$1 identifier=$pid address=$pid status=sent
    if [[ $scope == group ]]; then identifier=$pgid; address=-$pgid; fi
    if [[ -z $broker_pid ]] || ! kill -0 "$broker_pid" 2>/dev/null; then
        record PROTOCOL_ERROR ',"reason":"broker_guard_lost"'
        return 1
    fi
    kill -s "$name" -- "$address" 2>/dev/null || status=absent
    record SIGNAL_SENT ",\"signal\":\"$name\",\"scope\":\"$scope\",\"id\":$identifier,\"status\":\"$status\""
}
publish_reply() {
    "$python" -I -S -B "$directory/wr_request.py" reply "$attempt" >&10
    exec 10>&-
    replied=1
}
control_pending=
while :; do
    fragment=
    if IFS= read -r -t 0.05 fragment <&3; then
        # A timed read can consume a prefix before its newline, even though
        # producers serialize their writes. Preserve that prefix across slices.
        IFS='|' read -r observed event a b <<< "$control_pending$fragment"
        control_pending=
        [[ $observed == "$nonce" ]] || { record PROTOCOL_ERROR ',"reason":"nonce_mismatch"'; break; }
        case $event in
            OWNED_CHILD)
                record "$event" ",\"pid\":$a,\"role\":\"$b\""
                if [[ $b == broker ]]; then broker_pid=$a; fi
                ;;
            REAPED_HELPER) record "$event" ",\"pid\":$a";;
            EXEC_OK)
                pid=$a; pgid=$b
                record "$event" ",\"pid\":$pid,\"pgid\":$pgid"
                if [[ -n $deadline ]]; then start_watch "$deadline" DEADLINE; watcher=$last_watch; fi
                ;;
            LIVE)
                record "$event" ",\"pid\":$a"
                if [[ $mode == detached && $replied == 0 ]]; then publish_reply; fi
                ;;
            LAUNCH_FAILED) launch_failed=1; record "$event" ",\"errno\":$a";;
            TARGET_EXIT) target_exit=1; record "$event" ",\"si_code\":$a,\"si_status\":$b";;
            STREAM_EOF) ((eof_count+=1)); record "$event" ",\"stream\":\"$a\"";;
            DEADLINE)
                record "$event"
                timed_out=1
                send_signal "$first_signal"
                if [[ -n $escalation ]]; then grace_done=0; start_watch "$grace" GRACE_EXPIRED; grace_watcher=$last_watch; fi
                ;;
            GRACE_EXPIRED)
                record "$event"
                send_signal "$escalation"
                grace_done=1
                ;;
            REAPED) reaped=1; record "$event" ",\"pid\":$a";;
            BROKER_ENDED)
                ended=1; record "$event" ",\"status\":$a"
                if [[ $a != 0 ]] || { [[ $launch_failed == 0 && $reaped == 0 ]]; }; then
                    record PROTOCOL_ERROR ',"reason":"broker_failed"'
                    break
                fi
                ;;
            *) record PROTOCOL_ERROR ',"reason":"unknown_event"'; break;;
        esac
    else
        control_pending+=$fragment
        if ((${#control_pending}>4096)); then
            record PROTOCOL_ERROR ',"reason":"oversize_control_record"'
            break
        fi
        if ! kill -0 "$broker_wrapper" 2>/dev/null && [[ $ended == 0 ]]; then
            record PROTOCOL_ERROR ',"reason":"broker_wrapper_lost"'
            break
        fi
    fi
    if [[ $target_exit == 1 && $eof_count == "$eof_expected" && $released == 0 ]]; then
        if [[ $timed_out == 0 ]]; then
            cancel_watch "$watcher"; watcher=
            grace_done=1
        elif [[ $scope == child && $grace_done == 0 ]]; then
            cancel_watch "$grace_watcher"; grace_watcher=
            grace_done=1
        fi
        if [[ $grace_done == 1 ]]; then printf 'RELEASE\n' >&4; released=1; fi
    fi
    if [[ $ended == 1 && $eof_count == "$eof_expected" ]] && { [[ $launch_failed == 1 ]] || [[ $reaped == 1 ]]; }; then
        wait "$broker_wrapper" || true
        record REAPED_HELPER ",\"pid\":$broker_wrapper"
        for child in "${collectors[@]}"; do wait "$child"; record REAPED_HELPER ",\"pid\":$child"; done
        cancel_watch "$watcher"
        cancel_watch "$grace_watcher"
        # All owned producers have now been waited. Retain their queued reap
        # witnesses before the single receipt owner publishes completion.
        while IFS='|' read -r -t 0.05 observed event a b <&3; do
            [[ $observed == "$nonce" ]] || { record PROTOCOL_ERROR; exit 1; }
            case $event in
                OWNED_CHILD) record "$event" ",\"pid\":$a,\"role\":\"$b\"";;
                REAPED_HELPER) record "$event" ",\"pid\":$a";;
            esac
        done
        record FINISHED
        if [[ $mode == detached && $replied == 0 ]]; then publish_reply; fi
        exit 0
    fi
done
if [[ $mode == detached && $replied == 0 ]]; then publish_reply; fi
exit 1

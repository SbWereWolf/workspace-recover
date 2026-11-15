"""Public flow CLI projection, separate from business acceptance."""
from pathlib import Path
from command_execution.documents import stringify, loads
from . import flow
from .util import read_json
from .session_output import select_session
import json

DEFAULT_TEMPLATE = {"schema": "workspace-recover/flow/v3", "_comment": "Consider running your project automated tests after recovery, when applicable.", "steps": []}
USAGE = """workspace-recover flow run --manifest FILE --session DIR [--workspace DIR] [--bridge DIR] [--limit N]
workspace-recover flow run --session DIR
workspace-recover flow status --session DIR
workspace-recover flow decide --session DIR --request ID --choice CHOICE [--params JSON]
workspace-recover flow presented --session DIR --request ID
workspace-recover flow host-plan --session DIR
workspace-recover flow host-claim --session DIR
workspace-recover flow reply --session DIR --result RAW_RESULT.json [--path MATERIALIZED_FILE]
workspace-recover flow template [--output FILE]
"""


def main(argv):
    if not argv or argv[0] in ("help", "--help"):
        print(USAGE, end="")
        return 0
    action, argv = argv[0], argv[1:]
    options = {}
    known = {"manifest", "session", "workspace", "bridge", "limit", "request", "choice", "params", "result", "path", "output", "attachments"}
    for index in range(0, len(argv), 2):
        key = argv[index].removeprefix("--")
        if key not in known or not argv[index].startswith("--") or index + 1 == len(argv): raise ValueError(f"Invalid option {argv[index]}")
        options[key] = argv[index + 1]
    if action == "template":
        text = stringify(DEFAULT_TEMPLATE, indent=2) + "\n"
        if options.get("output"):
            with open(options["output"], "x", encoding="utf-8") as stream: stream.write(text)
        else: print(text, end="")
        return 0
    if not options.get("session"): raise ValueError("A session location is needed: --session DIR.")
    directory = Path(options["session"]).absolute()
    select_session(None, directory, flow=True)
    limit = int(options["limit"]) if options.get("limit") else float("inf")
    if action == "run":
        manifest_path = Path(options["manifest"]).absolute() if options.get("manifest") else None
        manifest = read_json(manifest_path, strip_bom=True) if manifest_path else None
        result = flow.run_flow(directory, manifest, manifest_path, options.get("workspace"), options.get("bridge"), limit)
    elif action == "status": result = flow.flow_status(directory)
    elif action == "decide": result = flow.decide_flow(directory, options.get("request"), options.get("choice"), loads(options.get("params", "{}"), "wr-json-v1"), limit)
    elif action == "presented": result = flow.record_presented(directory, options.get("request"))
    elif action == "host-plan": result = flow.host_plan(directory)
    elif action == "host-claim": result = flow.claim_host(directory)
    elif action == "reply":
        if not options.get("result"): raise ValueError("Pass raw connector output with --result FILE.")
        result = flow.reply_flow(directory, read_json(options["result"]), options.get("path"), read_json(options["attachments"]) if options.get("attachments") else [])
    else: raise ValueError(f"Unknown flow command: {action}")
    print(stringify(result, indent=2))
    return {"WAITING_DECISION": 10, "WAITING_HOST": 11, "WAITING_RETRY": 12, "BUSY": 13, "PAUSED": 14, "STOPPED": 15}.get(result.get("status"), 0)

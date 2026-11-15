"""Legacy ordered workflow and advisory policy; CE executes each command."""
from pathlib import Path
import re
from command_execution.commands import prepare_invocation
from command_execution.processes import execute_invocation
from command_execution.parameters import render
from .reporting import validate_reporter, build_step_report, build_aggregate_report
from .util import now_iso, write_json


def validate_workflow(steps):
    if not isinstance(steps, list): raise ValueError("workflow must be an array")
    seen = set()
    for index, step in enumerate(steps):
        if not isinstance(step, dict) or not isinstance(step.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", step["id"]) or step["id"] in seen: raise ValueError(f"workflow step id is unsafe or duplicated at index {index}")
        seen.add(step["id"])
        if step.get("type") not in ("command", "verification"): raise ValueError(f"unsupported workflow step at index {index}")
        if step.get("when", "success") not in ("success", "always"): raise ValueError(f"workflow step {step['id']} has unsupported when")
        if not isinstance(step.get("argv"), list) or not step["argv"] or not step["argv"][0] or any(not isinstance(x, str) or "\0" in x for x in step["argv"]): raise ValueError(f"workflow step {step['id']} requires argv string array")
        if "cwd" in step and not isinstance(step["cwd"], str): raise ValueError("workflow step requires a string cwd")
        if "timeoutMs" in step and (type(step["timeoutMs"]) is not int or step["timeoutMs"] <= 0): raise ValueError("workflow step requires a positive timeoutMs")
        if "report" in step: validate_reporter(step["report"])
        if "env" in step and (not isinstance(step["env"], dict) or any(not isinstance(x, str) for x in step["env"].values())): raise ValueError("workflow step requires string env values")


def run_command(step, workspace, step_dir, context):
    invocation = prepare_invocation(step, context, base_dir=str(workspace), profile="wr-workflow")
    out, err = Path(step_dir) / "stdout.log", Path(step_dir) / "stderr.log"
    timeout = {"milliseconds": step["timeoutMs"], "scope": "child", "firstSignal": "SIGTERM", "escalation": {"signal": "SIGKILL", "delayMs": 250}} if step.get("timeoutMs") else None
    started = now_iso()
    result = execute_invocation(invocation, {"mode": "foreground", "environment": "inherit", "session": "inherit", "timeout": timeout,
        "stdout": {"kind": "file", "path": str(out), "mode": "truncate"}, "stderr": {"kind": "file", "path": str(err), "mode": "truncate"}})
    launch_error = result["launch_error"]
    return {"id": step["id"], "type": step["type"], "argv": invocation["argv"], "cwd": invocation["cwd"],
        "status": "error" if launch_error else "passed" if result["kind"] == "finished" and not result["timed_out"] and result["exit_code"] == 0 else "failed",
        "exitCode": result["exit_code"], "signal": result["signal"]["name"] if result["signal"] else None,
        "spawnError": launch_error["message"] if launch_error else None, "timedOut": result["timed_out"], "startedAt": started, "finishedAt": now_iso(), "durationMs": int(result["duration_ms"] or 0),
        "stdout": out.read_text(encoding="utf-8", errors="replace"), "stderr": err.read_text(encoding="utf-8", errors="replace"), "stdoutPath": str(out), "stderrPath": str(err)}


def execute_workflow(steps, workspace, session_dir, context=None):
    validate_workflow(steps)
    results, hard_failure, warnings = [], False, False
    workspace, session_dir = Path(workspace), Path(session_dir)
    for index, step in enumerate(steps):
        if hard_failure and step.get("when", "success") != "always":
            results.append({"id": step["id"], "type": step["type"], "status": "skipped", "exitCode": None, "reason": "prior hard failure"})
            continue
        directory = session_dir / "steps" / f"{index:03}-{step['id']}"
        directory.mkdir(parents=True, exist_ok=True)
        selected = {"workspace": str(workspace), "stepDir": str(directory), **(context or {})}
        result = run_command(step, workspace, directory, selected)
        try:
            result["report"] = build_step_report(result, render(step.get("report", {"profile": "command-output"}), selected, "wr-workflow"), directory / "report", workspace)
        except Exception as error:
            result["reportError"] = str(error)
            full = directory / "report-error.json"
            write_json(full, {"result": result, "reportingError": str(error)})
            result["report"] = {"short": f"report unavailable; command={result['status']}", "medium": f"Reporter error: {error}\nCommand exit: {result['exitCode']}\nRaw stdout: {result['stdoutPath']}\nRaw stderr: {result['stderrPath']}", "fullPath": str(full)}
            warnings = True
        results.append(result)
        if result["status"] != "passed":
            if step["type"] == "verification": warnings = True
            else: hard_failure = True
    verification = build_aggregate_report("verification", [r for r in results if r["type"] == "verification"], session_dir / "reports" / "verification")
    workflow = build_aggregate_report("workflow", results, session_dir / "reports" / "workflow")
    return {"results": results, "hardFailure": hard_failure, "advisoryWarnings": warnings, "verificationReport": verification, "workflowReport": workflow}

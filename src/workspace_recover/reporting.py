"""Primary evidence and caller-selected human report projections."""
from pathlib import Path
import re
import shutil
from .invocation import prepare_invocation
from .processes import execute_invocation
from .json_files import loads, stringify
from command_execution.parameters import js_string
from .util import write_json, write_text, read_json, file_record

PROFILES = {"command-output", "json", "json-lines", "junit", "tap", "artifact-list", "custom-command"}


def validate_reporter(report):
    if not isinstance(report, dict) or report.get("profile", "command-output") not in PROFILES: raise ValueError("unsupported report profile")
    profile = report.get("profile")
    if profile in ("json", "json-lines", "junit") and not isinstance(report.get("source"), str): raise ValueError("report source is required")
    if profile == "artifact-list" and (not isinstance(report.get("sources"), list) or any(not isinstance(x, str) for x in report["sources"])): raise ValueError("artifact-list sources must be paths")
    if profile == "custom-command" and (not isinstance(report.get("argv"), list) or not report["argv"] or any(not isinstance(x, str) or "\0" in x for x in report["argv"])): raise ValueError("custom reporter requires argv")
    if "timeoutMs" in report and (type(report["timeoutMs"]) is not int or report["timeoutMs"] <= 0): raise ValueError("report timeout must be positive")


def preserve_source(source, directory, name=None):
    source, directory = Path(source), Path(directory)
    target = directory / (name or "source" + source.suffix)
    if not target.exists():
        import os
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    shutil.copyfile(source, target)
    return target


def junit_summary(xml):
    if not re.search(r"<testsuites?\b", xml): raise ValueError("JUnit report has no testsuite root")
    def attrs(text): return dict(re.findall(r'''([\w:-]+)\s*=\s*["']([^"']*)["']''', text))
    root = attrs(re.search(r"<testsuites?\b([^>]*)>", xml, re.I).group(1))
    if "tests" not in root:
        totals = dict(tests=0, failures=0, errors=0, skipped=0, time=0)
        stack = []
        for match in re.finditer(r"<(\/?)testsuite\b([^>]*)>", xml):
            if match.group(1):
                if stack: stack.pop()
                continue
            values, counted = attrs(match.group(2)), any(stack)
            own = "tests" in values
            if not counted and own:
                for key in totals: totals[key] += float(values.get(key, 0))
            if not match.group(2).rstrip().endswith("/"): stack.append(own or counted)
        root = totals
    failures = re.findall(r'''<(?:failure|error)\b[^>]*message=["']([^"']*)["'][^>]*>''', xml, re.I)[:10]
    return root, failures


def tap_summary(text):
    cases = [line for line in text.splitlines() if re.match(r"^(not )?ok\b", line)]
    def counter(name, default):
        matches = re.findall(r"^# " + name + r" (\d+)\s*$", text, re.M)
        return int(matches[-1]) if matches else default
    return {"tests": counter("tests", len(cases)), "failures": counter("fail", sum(line.startswith("not ok") and not re.search(r"# (TODO|SKIP)", line, re.I) for line in cases)),
            "skipped": counter("skipped", sum(bool(re.search(r"# SKIP", line, re.I)) for line in cases)), "failedCases": [line for line in cases if line.startswith("not ok")][:10]}


def build_step_report(result, report, report_dir, workspace):
    report = report or {"profile": "command-output"}
    validate_reporter(report)
    directory, workspace = Path(report_dir), Path(workspace)
    directory.mkdir(parents=True, exist_ok=True)
    primary = directory / "primary.json"
    write_json(primary, result)
    full = primary
    profile = report.get("profile", "command-output")
    if profile == "command-output":
        short = f"{result['status']}; exit={js_string(result.get('exitCode'))}; {js_string(result.get('durationMs'))}ms"
        detail = []
        for name in ("stderr", "stdout"):
            lines = [line.rstrip() for line in result.get(name, "").splitlines() if line.rstrip()]
            if lines: detail.extend([f"{name} ({len(lines)} lines):", *lines[-12:]])
        medium = "\n".join([f"status: {result['status']}", f"exitCode: {js_string(result.get('exitCode'))}", f"durationMs: {js_string(result.get('durationMs'))}",
                             f"stdoutBytes: {len(result.get('stdout', '').encode())}", f"stderrBytes: {len(result.get('stderr', '').encode())}", *detail])
    elif profile == "json":
        full = preserve_source(workspace / report["source"], directory)
        data = read_json(full)
        short = js_string(data.get(report["shortKey"])) if report.get("shortKey") else f"JSON result: {len(data)} top-level keys"
        medium = stringify(data, indent=2)[:report.get("mediumMaxChars", 12000)]
    elif profile == "junit":
        full = preserve_source(workspace / report["source"], directory)
        attrs, failures = junit_summary(full.read_text(encoding="utf-8", errors="replace"))
        short = " ".join(key + "=" + js_string(attrs.get(key, "?")) for key in ("tests", "failures", "errors", "skipped"))
        medium = short + "\ntime=" + js_string(attrs.get("time", "?")) + "\n" + ("failures:\n- " + "\n- ".join(failures) if failures else "no reported failure messages")
    elif profile == "tap":
        summary = tap_summary(result.get("stdout", ""))
        short = " ".join(key + "=" + str(summary[key]) for key in ("tests", "failures", "skipped"))
        medium = short + f"\ncommandExit={js_string(result.get('exitCode'))} durationMs={js_string(result.get('durationMs'))}\n" + ("\n".join(summary["failedCases"]) or "No failed cases reported")
    elif profile == "json-lines":
        full = preserve_source(workspace / report["source"], directory)
        rows = [loads(line) for line in full.read_text().splitlines() if line.strip()]
        counts = {}
        for row in rows:
            key = js_string(row.get("level", row.get("status", "record")))
            counts[key] = counts.get(key, 0) + 1
        short = f"{len(rows)} records; {full.stat().st_size} bytes"
        medium = short + "\nCounts by level/status: " + stringify(counts) + "\n" + "\n".join(stringify(row) for row in rows if row.get("error") or row.get("level") == "error" or row.get("status") == "failed")[:12000]
    elif profile == "artifact-list":
        artifacts = []
        for index, relative in enumerate(report["sources"]):
            source = workspace / relative
            saved = preserve_source(source, directory, f"artifact-{index}{source.suffix}")
            artifacts.append({"name": relative, **file_record(saved)})
        full = directory / "artifacts.json"
        write_json(full, {"schema": "workspace-recover/artifact-report/v3", "artifacts": artifacts})
        short = f"{len(artifacts)} artifacts; {sum(a['bytes'] for a in artifacts)} bytes"
        medium = short + "\n" + "\n".join(f"{a['name']}: {a['bytes']} bytes; SHA256 {a['sha256']}" for a in artifacts)
    else:
        context = {"primaryPath": str(primary), "stdoutPath": result.get("stdoutPath"), "stderrPath": result.get("stderrPath"), "workspace": str(workspace)}
        invocation = prepare_invocation({"argv": report["argv"], "env": {"WR_" + key.upper(): js_string(value) for key, value in context.items()}}, base_dir=str(workspace))
        response = execute_invocation(invocation, {"mode": "foreground", "environment": "inherit", "session": "inherit", "stdout": {"kind": "bytes"}, "stderr": {"kind": "bytes"},
            "timeout": {"milliseconds": report.get("timeoutMs", 120000), "scope": "child", "firstSignal": "SIGKILL"}})
        if response["kind"] != "finished" or response["exit_code"] != 0: raise ValueError(f"custom reporter failed with exit {response['exit_code']}: {response.get('stderr', b'').decode('utf-8', errors='replace').strip()}")
        data = loads(response["stdout"].decode("utf-8", errors="replace"))
        if not isinstance(data.get("short"), str) or not isinstance(data.get("medium"), str): raise ValueError("custom reporter must emit JSON with string short and medium")
        short, medium = data["short"], data["medium"]
        if data.get("fullPath"): full = preserve_source(workspace / data["fullPath"], directory)
    write_text(directory / "short.txt", short + "\n")
    write_text(directory / "medium.txt", medium + "\n")
    artifact = file_record(full)
    write_json(directory / "source-artifact.json", artifact)
    return {"short": short, "medium": medium, "fullPath": str(full), "sourceArtifact": artifact}


def build_aggregate_report(kind, items, report_dir):
    directory = Path(report_dir)
    directory.mkdir(parents=True, exist_ok=True)
    primary = directory / "primary.json"
    write_json(primary, {"type": kind, "items": items})
    warnings = [item for item in items if item["status"] != "passed" or item.get("reportError")]
    short = f"{len(items)} result(s); {len(warnings)} warning/error result(s)"
    medium = "\n".join(item["id"] + ": " + item["status"] + (" exit=" + str(item["exitCode"]) if item.get("exitCode") is not None else "") for item in items) or "no results"
    write_text(directory / "short.txt", short + "\n")
    write_text(directory / "medium.txt", medium + "\n")
    return {"short": short, "medium": medium, "fullPath": str(primary)}

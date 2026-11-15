"""Standalone public command entry; generic commands run through CE."""
import os
from pathlib import Path
import shutil
import sys
from command_execution.documents import stringify
from command_execution.commands import prepare_invocation
from command_execution.processes import execute_invocation
from . import __version__
from .util import read_json, write_json, home_dir, resource_path
from .formats import assert_format
from .template import load_values, render_template, describe_inputs
from .profiles import load_profile, create_profile, list_profiles
from .session import SessionStore

USAGE = """workspace-recover

Commands:
  flow run --manifest FILE --session DIR [--workspace DIR] [--limit N]
  flow status|host-plan|host-claim --session DIR
  flow decide --session DIR --request ID --choice CHOICE [--params JSON]
  flow template [--output FILE]
  bridge init|pending|submit --bridge DIR
  init <local|google-workspace|template> [--values FILE ...] [--project-dir DIR]
  template init|list|describe|render
  backup [template-name|template.json|manifest.json] [--state-dir DIR]
  restore [handoff|recovery.json] [--target DIR] [--state-dir DIR]
  continue|status|next|info [session-id] [--state-dir DIR]
  auth google-workspace|status|profiles
  profile create|show|list
"""


def emit(value): print(stringify(value, indent=2))


def parse_args(argv):
    flags = {"no-browser", "non-interactive", "interactive", "json", "short", "full"}
    multiple = {"values", "set", "set-json"}
    allowed = {"bridge", "capabilities", "results", "executor", "state-dir", "output", "preset", "target", "google-profile", "drive-folder", "handoff", "manifest", "view", "type", "profile", "client", "format", "editor", "project-dir", "template"} | multiple
    positional, options, index = [], {}, 0
    while index < len(argv):
        arg = argv[index]
        index += 1
        if not arg.startswith("--"):
            positional.append(arg)
            continue
        key, equal, text = arg[2:].partition("=")
        if key in flags:
            if equal: raise ValueError(f"--{key} is a flag")
            options[key] = True
            continue
        if key not in allowed: raise ValueError(f"unknown option --{key}")
        if not equal:
            if index == len(argv): raise ValueError(f"missing value for --{key}")
            text, index = argv[index], index + 1
        if text.startswith("--"): raise ValueError(f"missing value for --{key}")
        if key in multiple: options.setdefault(key, []).append(text)
        else:
            if key in options: raise ValueError(f"duplicate --{key}")
            options[key] = text
    if options.get("interactive") and options.get("non-interactive"): raise ValueError("--interactive conflicts with --non-interactive")
    return positional, options


def resolve_template(reference):
    reference = {"local": "local-project", "google-workspace": "google-workspace-project"}.get(reference, reference)
    direct = Path(reference).absolute()
    for candidate in (direct, home_dir("config") / "templates" / reference / "template.json", home_dir("config") / "templates" / (reference + ".json"), resource_path("templates", reference, "template.json")):
        if candidate.exists(): return candidate
    raise ValueError(f"template not found by name or path: {reference}")


def supplied(options): return load_values(options.get("values", []), options.get("set", []), options.get("set-json", []))


def print_session(session, options=None):
    import shlex
    options = options or {}
    state_arg = " --state-dir " + shlex.quote(str(Path(options["state-dir"]).absolute())) if options.get("state-dir") else ""
    print("State: " + session["state"])
    for key, value in session.get("result", {}).items(): print(f"{key}: {value}")
    next_action = session.get("next")
    if next_action and next_action["type"] != "none":
        print("Next: " + next_action.get("command", next_action.get("action", "")) + (state_arg if next_action.get("command") else ""))
        if next_action.get("required"): print("Missing: " + ", ".join(next_action["required"]))
        if next_action.get("errors"): print("Invalid: " + "; ".join(x["message"] for x in next_action["errors"]))
        if next_action.get("reason"): print("Reason: " + next_action["reason"])
    elif next_action: print("Next: none")
    print("Session: " + session["id"])
    print("More: workspace-recover info " + session["id"] + state_arg)


def maybe_edit(session, options, store):
    if not options.get("interactive") or session["state"] != "waiting_for_input" or not session.get("next", {}).get("valuesFile"): return session
    editor = options.get("editor") or os.environ.get("VISUAL") or os.environ.get("EDITOR")
    if not editor:
        print("Set EDITOR to an executable, or pass --editor PATH. The complete values form is preserved.", file=sys.stderr)
        return session
    invocation = prepare_invocation({"argv": [editor, session["next"]["valuesFile"]]}, base_dir=str(Path.cwd()))
    result = execute_invocation(invocation, {"mode": "foreground", "environment": "inherit", "session": "inherit", "stdout": {"kind": "inherit"}, "stderr": {"kind": "inherit"}, "timeout": None})
    if result["kind"] != "finished" or result["exit_code"] != 0: return session
    from .operations import continue_operation
    values, provenance = load_values([session["next"]["valuesFile"]])
    return continue_operation(store, session, values, provenance)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "flow":
        from .flow_cli import main as flow_main
        return flow_main(argv[1:])
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE, end="")
        return 0
    if len(argv) == 1 and argv[0] in ("version", "--version"):
        print(__version__)
        return 0
    positional, options = parse_args(argv)
    command = positional[0]
    action = positional[1] if len(positional) > 1 else None
    if command == "bridge":
        from .bridge import initialize_bridge, pending_requests, submit_results
        root = options.get("bridge")
        if not root: raise ValueError("bridge requires --bridge DIR")
        if action == "init": result = initialize_bridge(root, read_json(options["capabilities"]))
        elif action == "pending": result = pending_requests(root, positional[2] if len(positional) > 2 else None)
        elif action == "submit": result = submit_results(root, read_json(options["results"]))
        else: raise ValueError("bridge requires init, pending or submit")
        emit(result)
        return 0
    if command == "profile":
        if action == "list": result = list_profiles()
        elif action == "show": result = load_profile(positional[2])
        elif action == "create":
            values, _ = supplied(options)
            result = create_profile(positional[2], values)
        else: raise ValueError("profile requires create, show or list")
        emit(result)
        return 0
    if command == "auth":
        from .providers.google_workspace import auth_status, authorize
        profile = options.get("profile", "default")
        if action == "status": emit(auth_status(profile))
        elif action == "profiles":
            directory = home_dir("config") / "google-workspace"
            emit([p.name for p in directory.iterdir() if p.is_dir()] if directory.exists() else [])
        elif action == "google-workspace":
            result = authorize(options.get("client"), profile, no_browser=bool(options.get("no-browser")))
            print(f"Google Workspace profile authorized: {result['profile']}\nToken: {result['tokenPath']}")
        else: raise ValueError("auth requires google-workspace or status")
        return 0
    if command == "template":
        if action == "list":
            names = set()
            for root in (resource_path("templates"), home_dir("config") / "templates"):
                if root.exists(): names.update(p.name for p in root.iterdir() if p.is_dir() and (p / "template.json").exists())
            for name in sorted(names): print(name)
        elif action == "describe": emit(describe_inputs(read_json(resolve_template(positional[2]))))
        elif action == "render":
            if len(positional) < 3 or not options.get("output"): raise ValueError("template render requires <template-name|template.json> --output <manifest.json>")
            values, provenance = supplied(options)
            result = render_template(read_json(resolve_template(positional[2])), values, provenance)
            if result["missing"] or result["errors"]: raise ValueError(stringify({"missing": result["missing"], "errors": result["errors"]}))
            output = Path(options["output"]).absolute()
            write_json(output, result["manifest"], 0o644)
            print("Manifest: " + str(output))
        elif action == "init":
            if len(positional) < 3 or not options.get("preset"): raise ValueError("template init requires <name> --preset <preset>")
            target = Path(options["output"]) if options.get("output") else home_dir("config") / "templates" / positional[2]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.mkdir()
            template = assert_format(read_json(resource_path("templates", options["preset"], "template.json")), "template")
            template["name"] = positional[2]
            write_json(target / "template.json", template, 0o644)
            from .util import set_path
            values = {}
            for key, definition in template.get("inputs", {}).items(): set_path(values, key, definition.get("default"))
            write_json(target / "values.example.json", {"schema": "workspace-recover/values/v3", "values": values}, 0o644)
            print(f"Template: {target / 'template.json'}\nValues example: {target / 'values.example.json'}")
        else: raise ValueError("unknown template action")
        return 0
    store = SessionStore(options.get("state-dir"))
    if command in ("status", "next", "info", "continue"):
        identifier = action or store.current()
        session = store.load(identifier)
        if command == "status": print_session(session, options)
        elif command == "next": emit({"session": identifier, "state": session["state"], "next": session.get("next")})
        elif command == "info":
            views = sum(bool(options.get(k)) for k in ("short", "full", "view"))
            if views > 1: raise ValueError("Choose one info view")
            view = "full" if options.get("full") else "short" if options.get("short") else options.get("view", "medium")
            if view not in ("short", "medium", "full"): raise ValueError(f"unsupported info view: {view}")
            kind = options.get("type")
            if not kind and view == "full": print(store.directory(identifier) / "session.json")
            elif not kind:
                print(f"Session: {identifier}\nState: {session['state']}\nInformation types:")
                for name, data in session.get("info", {}).items(): print(f"  {name}: {data[view]}")
            else:
                data = session.get("info", {}).get(kind)
                if data is None: raise ValueError(f"information type is not available: {kind}")
                print(data["fullPath"] if view == "full" else data[view])
        else:
            if options.get("executor") or options.get("bridge"): raise ValueError("continue uses the stored executor, not a new override")
            from .operations import continue_operation
            if options.get("results"):
                from .bridge import submit_results
                bridge = session.get("execution", {}).get("bridge") or (session.get("next") or {}).get("bridge")
                if not bridge: raise ValueError("session has no connector bridge")
                submit_results(bridge, read_json(options["results"]))
            values, provenance = supplied(options)
            session = continue_operation(store, session, values, provenance)
            session = maybe_edit(session, options, store)
            print_session(session, options)
            return 1 if session["state"] == "failed" else 2 if session["state"].startswith("waiting_") else 0
        return 0
    if command in ("backup", "restore", "init"):
        from .operations import start_operation
        session = start_operation(command, positional[1:], options, store)
        session = maybe_edit(session, options, store)
        print_session(session, options)
        return 1 if session["state"] == "failed" else 2 if session["state"].startswith("waiting_") else 0
    raise ValueError(f"unknown command: {command}\n\n{USAGE}")


def entrypoint():
    try: code = main()
    except Exception as error:
        if getattr(error, "session", None): print_session(error.session, {"state-dir": str(error.state_root)})
        print(f"workspace-recover: {error}", file=sys.stderr)
        code = 1
    raise SystemExit(code)

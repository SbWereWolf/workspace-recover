"""Pure normalized invocation preparation for caller-selected grammars."""
from pathlib import Path
import os
from command_execution import TemplateRenderer


def prepare_invocation(command, parameters=None, *, base_dir, profile="resolved"):
    if not Path(base_dir).is_absolute():
        raise ValueError("base_dir must be an absolute path")
    selected = {key: command.get(key, default) for key, default in (("argv", None), ("cwd", "."), ("env", {}))}
    selected = TemplateRenderer().render(selected, parameters or {}, profile)
    argv = selected["argv"]
    if not isinstance(argv, list) or not argv or not argv[0] or any(not isinstance(item, str) or "\0" in item for item in argv):
        raise ValueError("command needs argv strings with a nonempty executable")
    if not isinstance(selected["cwd"], str) or not selected["cwd"] or "\0" in selected["cwd"]:
        raise ValueError("command needs a nonempty cwd")
    env = selected["env"]
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        raise ValueError("command needs a string environment map")
    directory = Path(base_dir) / selected["cwd"]
    selected["cwd"] = str(directory) if profile == "python-template" else os.path.abspath(directory)
    return selected

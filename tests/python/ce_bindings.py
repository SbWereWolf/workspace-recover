"""Test-only selection of public CE seams; no candidate behavior is implemented."""
import importlib
import json
import os

DEFAULT_BINDINGS = {
    "read": "command_execution.configuration.json_file.read_json",
    "write": "command_execution.configuration.json_file.write_json",
    "prepare": "command_execution.plan_action",
    "execute": "command_execution.actions.process.run_command",
    "signal": "command_execution.actions.process.signal_process",
}


class CapabilityAbsent(AssertionError):
    pass


def resolve(role):
    selected = {**DEFAULT_BINDINGS, **json.loads(os.environ.get("CE_TEST_BINDINGS_JSON", "{}"))}
    module_name, _, name = selected[role].rpartition(".")
    module = importlib.import_module(module_name)  # A bad selection/import is a setup ERROR, not RED.
    function = getattr(module, name, None)
    if not callable(function):
        raise CapabilityAbsent(f"Selected public CE capability {role} is absent: {selected[role]}")
    if not getattr(function, "__module__", "").startswith("command_execution"):
        raise AssertionError("A test adapter or private WR implementation is not a public CE seam")
    return module, name, function

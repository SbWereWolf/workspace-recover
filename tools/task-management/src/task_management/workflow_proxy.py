#!/usr/bin/env python3
"""Route project workflow commands to the explicitly configured Poise launcher."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


OPERATIONS = {
    "task-ctl": frozenset(("task", "show")),
    "sprint-ctl": frozenset(("sprint", "show")),
    "req-ctl": frozenset((
        "query", "apply", "rollback", "command", "squash", "export", "rebase",
    )),
    "exec-ctl": frozenset((
        "restore_context", "routing", "bootstrap", "verify", "show",
        "accept", "reuse", "recover_empty_rework", "recover_empty_advance",
        "advance", "recover_missing_worktree", "recover_ownership",
        "recover_artifacts", "artifact_drafts", "cancel",
        "artifacts", "integrate", "cleanup", "initialize_stage_contracts",
        "revise_stage_contract", "release", "delivery", "handoff", "task_feedback",
    )),
}


class ProxyError(Exception):
    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(raw: bytes, source: str, exit_code: int) -> Any:
    try:
        return json.loads(raw, object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ProxyError(
            f"Некорректный JSON в {source}: {error}. Исправьте документ и повторите вызов.",
            exit_code,
        ) from error


def _path(settings: dict[str, Any], settings_path: Path, key: str, *, directory: bool) -> Path:
    value = settings.get(key)
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ProxyError(
            f"В {settings_path} отсутствует обязательный путь {key}. "
            "Исправьте конфиг: укажите путь относительно его каталога.",
            3,
        )
    path = Path(value)
    if path.is_absolute():
        raise ProxyError(f"{key} в {settings_path} должен быть относительным путём. Исправьте конфиг.", 3)
    path = settings_path.resolve().parent / path
    if not (path.is_dir() if directory else path.is_file()):
        raise ProxyError(
            f"Недоступен {key}: {value}. Исправьте путь в {settings_path}.",
            3,
        )
    return path


def load_settings(path: Path) -> tuple[Path, Path, Path]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ProxyError(
            f"Недоступен конфиг {path}: {error}. Создайте его по "
            "task-management/settings.example.json и задайте пути экземпляра Poise.",
            3,
        ) from error
    settings = _read_json(raw, str(path), 3)
    if (
        not isinstance(settings, dict)
        or type(settings.get("schema_version")) is not int
        or settings["schema_version"] != 3
    ):
        raise ProxyError(
            f"Неверная схема конфига {path}. Выполните start-app adjust для перехода на schema_version 3.",
            3,
        )
    if settings.get("backend") != "poise":
        raise ProxyError(
            f"Неизвестный backend в {path}. Настройте поддерживаемый backend poise.",
            3,
        )
    project_id = settings.get("project_id")
    if not isinstance(project_id, str) or not project_id.strip() or "\0" in project_id:
        raise ProxyError(f"В {path} требуется непустой project_id. Исправьте конфиг.", 3)
    launcher = _path(settings, path, "launcher", directory=False).resolve()
    workdir = _path(settings, path, "working_directory", directory=True)
    project_config = _path(settings, path, "project_config", directory=False)
    try:
        project = _read_json(project_config.read_bytes(), str(project_config), 3)
    except OSError as error:
        raise ProxyError(f"Не удалось прочитать project_config {project_config}: {error}.", 3) from error
    if not isinstance(project, dict) or project.get("project") != project_id:
        raise ProxyError(
            f"project_config в {path} должен выбирать настроенный project_id {project_id!r}: {project_config}.",
            3,
        )
    return launcher, workdir, project_config.resolve()


def _validate_caller(environment: dict[str, str]) -> None:
    identities = [environment[key] for key in ("CODEX_SESSION_ID", "CODEX_THREAD_ID") if key in environment]
    if (not identities or any(not value.strip() for value in identities)
            or len(set(identities)) != 1 or environment.get("POISE_CALLER_BINDING")):
        raise ProxyError(
            "Не определён однозначный настоящий сеанс. Запустите команду из сеанса Codex с согласованными "
            "CODEX_SESSION_ID/CODEX_THREAD_ID и без POISE_CALLER_BINDING.",
            3,
        )


def execute_command(arguments: list[str], settings_path: Path) -> subprocess.CompletedProcess:
    launcher, workdir, project_config = load_settings(settings_path)
    environment = os.environ.copy()
    environment["POISE_CONFIG"] = str(project_config)
    environment["TASK_MANAGEMENT_SELECTED_SETTINGS"] = str(settings_path.resolve())
    _validate_caller(environment)
    try:
        return subprocess.run(["bash", str(launcher), *arguments],
                              cwd=None if arguments[0] == "requirements" else workdir,
                              env=environment, check=False)
    except OSError as error:
        raise ProxyError(
            f"Не удалось запустить project launcher из {settings_path}: {error}. Проверьте Bash и исправьте конфиг.",
            3,
        ) from error


def execute(tool: str, packet: bytes, settings_path: Path) -> subprocess.CompletedProcess[bytes]:
    operations = OPERATIONS.get(tool)
    if operations is None:
        raise ProxyError(f"Неизвестная команда транспорта {tool}. Используйте одну из четырёх proxy-команд.", 2)
    document = _read_json(packet, "stdin", 2)
    operation = document.get("operation") if isinstance(document, dict) else None
    if not isinstance(operation, str) or operation not in operations:
        known = ", ".join(sorted(operations))
        raise ProxyError(
            f"{tool} не знает операцию {operation!r}. Поддерживаются: {known}.",
            2,
        )


    launcher, workdir, project_config = load_settings(settings_path)
    environment = os.environ.copy()
    environment["POISE_CONFIG"] = str(project_config)
    environment["TASK_MANAGEMENT_SELECTED_SETTINGS"] = str(settings_path.resolve())
    if tool == "req-ctl":
        command = ["bash", str(launcher), "requirements", "--config", str(project_config)]
    else:
        _validate_caller(environment)
        command = ["bash", str(launcher), "work"]
    try:
        return subprocess.run(
            command,
            input=packet,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=None if tool == "req-ctl" else workdir,
            env=environment,
            check=False,
        )
    except OSError as error:
        raise ProxyError(
            f"Не удалось запустить project launcher из {settings_path}: {error}. Проверьте Bash и исправьте конфиг.",
            3,
        ) from error


def main(argv: list[str]) -> int:
    selected_settings = None
    if len(argv) > 1 and argv[1] == "--config":
        if len(argv) < 3:
            print("После --config укажите путь к JSON-конфигурации приложения.", file=sys.stderr)
            return 2
        selected_settings = argv[2]
        argv = [argv[0], *argv[3:]]
    if not argv or (len(argv) != 1 and (
            argv[0] != "exec-ctl" or len(argv) < 3 or argv[1] != "--command" or not argv[2])):
        print("Передайте JSON через stdin без аргументов либо используйте exec-ctl --command COMMAND [ARGUMENTS...].",
              file=sys.stderr)
        return 2
    tool = argv[0]
    try:
        settings = os.environ.get("TASK_MANAGEMENT_SETTINGS") if selected_settings is None else selected_settings
        if settings is None or (selected_settings is None and not settings):
            raise ProxyError(
                "Отсутствует TASK_MANAGEMENT_SETTINGS. Задайте путь к настроенному "
                "конфигу по task-management/settings.example.json.",
                3,
            )
        settings_path = Path(settings)
        if not settings_path.is_absolute():
            settings_path = Path(__file__).resolve().parents[2] / settings_path
        if len(argv) > 1:
            result = execute_command(argv[2:], settings_path)
        else:
            result = execute(tool, sys.stdin.buffer.read(), settings_path)
    except ProxyError as error:
        print(f"{tool}: {error}", file=sys.stderr)
        return error.exit_code
    if len(argv) == 1:
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
    return 128 - result.returncode if result.returncode < 0 else result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

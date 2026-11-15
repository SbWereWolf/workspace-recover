"""Versioned public document family, with no format fallback."""
from .util import integer

FORMAT_VERSION = 3
FEATURES = {"advisory-workflow", "saved-reports", "named-actions", "batch-inputs", "google-workspace",
            "local-files", "tar-gzip", "pax-paths", "safe-merge", "selection-inventory", "archive-profiles"}


def schema(kind):
    return f"workspace-recover/{kind}/v3"


def assert_format(document, kind):
    if not isinstance(document, dict) or document.get("schema") != schema(kind):
        actual = document.get("schema", "missing") if isinstance(document, dict) else "missing"
        raise ValueError(f"unsupported {kind} schema: expected {schema(kind)}, got {actual}. Use the tool release for that format.")
    return document


def assert_requirements(requires):
    if requires is None:
        return
    if not isinstance(requires, dict) or requires.get("formatVersion") != 3:
        raise ValueError("unsupported required formatVersion")
    if "features" in requires and (not isinstance(requires["features"], list) or any(x not in FEATURES for x in requires["features"])):
        raise ValueError("unsupported required feature/capability")


def assert_transport(transport):
    import re
    assert_format(transport, "transport-manifest")
    archive = transport.get("archive", {})
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,31}", archive.get("format", "")): raise ValueError("unsupported archive format")
    if not integer(archive.get("bytes")) or archive["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", archive.get("sha256", "")): raise ValueError("invalid transport archive size or SHA256")
    if not isinstance(transport.get("parts"), list) or not transport["parts"]: raise ValueError("transport requires parts")
    for part in transport["parts"]:
        if not integer(part.get("bytes")) or part["bytes"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", part.get("sha256", "")) or not isinstance(part.get("remote", {}).get("id"), str): raise ValueError("invalid transport part metadata")
    return transport

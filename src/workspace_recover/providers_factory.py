"""Resource identities and frozen machine-specific execution routing."""
from pathlib import Path
import re
from .bridge import ConnectorBoundary, validate_capabilities
from .formats import schema, assert_format
from .util import read_json, write_json, canonical, sha256_text
from .providers.local_files import LocalFilesProvider
from .providers.google_workspace import GoogleWorkspaceProvider, auth_status
from .providers.connector import ConnectorProvider


def resource_provider(config):
    if config["type"] == "google-workspace": return {"type": config["type"], **({"folderId": config["folderId"]} if config.get("folderId") else {})}
    return {key: value for key, value in config.items() if key not in ("executor", "bridge", "account", "waitTimeoutMs")}


def provider_context(store, session, role, operations, execution=None):
    def pending(request, bridge):
        session.setdefault("externalRequests", {})[request["requestId"]] = {"operation": request["operation"], "state": "pending", "requestHash": request["requestHash"]}
        session.update(state="waiting_for_connector", next={"type": "automatic", "action": "host-connectors", "bridge": bridge, "command": "workspace-recover bridge pending --bridge " + canonical(bridge), "requestId": request["requestId"]})
        session.setdefault("connectorRecords", {})[request["requestId"]] = {"request": request}
        full = store.write(session["id"], "connector-exchanges.json", {"schema": schema("connector-exchanges"), "requests": session["connectorRecords"]})
        session["info"]["connector"] = {"short": "Host operations pending", "medium": request["operation"] + ": " + request["requestId"], "fullPath": full}
        store.save(session)
    def resolved(request, answer):
        session.setdefault("externalRequests", {})[request["requestId"]] = {"operation": request["operation"], "state": "completed", "requestHash": request["requestHash"]}
        session.setdefault("connectorRecords", {})[request["requestId"]] = {"request": request, "response": answer}
        full = store.write(session["id"], "connector-exchanges.json", {"schema": schema("connector-exchanges"), "requests": session["connectorRecords"]})
        records = session["connectorRecords"]
        session["info"]["connector"] = {"short": f"{len(records)} host operation record(s)", "medium": "\n".join(item["request"]["operation"] + ": " + item.get("response", {}).get("status", "pending") for item in records.values()), "fullPath": full}
        session.update(state="running", next=None)
        store.save(session)
    def route(value):
        session.setdefault("executors", {})[role] = value
        store.save(session)
    def synchronized(function):
        def invoke(*args):
            with store._lock: return function(*args)
        return invoke
    return {**(execution or {}), "sessionId": session["id"], "sessionDir": str(store.directory(session["id"])), "role": role, "requiredOperations": operations, "onPending": synchronized(pending), "onResolved": synchronized(resolved), "onRoute": synchronized(route)}


class RoutedProvider:
    type = "google-workspace"
    def __init__(self, config): self.config, self.delegate = config, None
    def resolve(self):
        if self.delegate is not None: return self.delegate
        config = self.config
        requested = config["executor"]
        if requested not in ("direct", "connector", "delegated", "auto"): raise ValueError(f"unsupported executor: {requested}")
        file = Path(config["sessionDir"]) / "executors" / (config.get("role", "google") + ".json") if config.get("sessionDir") else None
        policy = {"requested": requested, "bridge": config.get("bridge"), "account": config.get("account"), "profile": config.get("profile", "default"), "operations": config.get("requiredOperations", [])}
        digest = sha256_text(canonical(policy))
        if file and file.exists():
            route = assert_format(read_json(file), "executor-route")
            if route["policySha256"] != digest: raise ValueError("frozen executor policy changed")
        else:
            mode, account = requested, config.get("account")
            if mode == "auto":
                capabilities = Path(config["bridge"]) / "capabilities.json" if config.get("bridge") else None
                if capabilities and capabilities.exists():
                    value = validate_capabilities(read_json(capabilities))
                    if account and account != value["account"]: raise ValueError("auto connector account mismatch")
                    if all(op in value["operations"] for op in config.get("requiredOperations", [])): mode, account = "connector", value["account"]
                if mode == "auto":
                    auth = auth_status(config.get("profile", "default"))
                    if auth["clientPresent"] and auth["tokenPresent"]: mode = "direct"
                    else: raise ConnectorBoundary("No complete registered connector or configured direct profile", "CAPABILITY_REQUIRED")
            route = {"schema": schema("executor-route"), "mode": mode, "account": account, "policySha256": digest}
            if mode in ("connector", "delegated"):
                self.delegate = ConnectorProvider({**config, "executor": mode, "account": account})
                route["account"] = self.delegate.ready()["account"]
            if file: write_json(file, route)
        if self.delegate is None:
            self.delegate = GoogleWorkspaceProvider(config.get("profile", "default"), config.get("driveFolderId")) if route["mode"] == "direct" else ConnectorProvider({**config, "executor": route["mode"], "account": route["account"]})
        self.executor = route["mode"]
        if config.get("onRoute"): config["onRoute"](route)
        return self.delegate
    def __getattr__(self, name): return getattr(self.resolve(), name)


def provider_from_config(config, overrides=None):
    if not isinstance(config, dict) or not config.get("type"): raise ValueError("provider type is required")
    selected = {**config, **(overrides or {})}
    if config["type"] == "local-files": return LocalFilesProvider(selected["root"], selected.get("handoffRoot"), selected.get("readOnly", False))
    if config["type"] == "google-workspace": return RoutedProvider(selected) if selected.get("executor") else GoogleWorkspaceProvider(selected.get("profile", "default"), selected.get("driveFolderId"))
    raise ValueError(f"unsupported provider type: {config['type']}")


def handoff_provider(reference, google_profile="default", **context):
    if reference.startswith("https://mail.google.com/") or re.fullmatch(r"[a-fA-F0-9]{12,}", reference): return provider_from_config({"type": "google-workspace", "profile": google_profile}, context)
    if re.match(r"https?:", reference): raise ValueError("unsupported handoff URL host/protocol")
    return LocalFilesProvider(".", ".", read_only=True)

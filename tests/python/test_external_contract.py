"""Independent public CLI preservation contracts, not translated JS tests."""
import hashlib
import json
from pathlib import Path
import re
import stat
import tarfile
import io
import time
import os
import signal
import subprocess
import sys

from support import CliContract, FIXTURE


class FlowContracts(CliContract):
    def test_stock_template_is_an_empty_declaration(self):
        result = self.answer("flow", "template")
        self.assertEqual(result["schema"], "workspace-recover/flow/v3")
        self.assertEqual(result["steps"], [])

    def test_empty_flow_completes_without_a_decision(self):
        result = self.flow([])
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["completedSteps"], 0)
        self.assertIsNone(result["decisionRequest"])
        self.assertFalse(result["questionNeeded"])

    def test_future_path_and_typed_output_are_consumed_at_their_stage(self):
        result = self.flow([
            {"id": "folder", "op": "mkdir", "path": "future directory"},
            self.write_step("file", "future directory/δ.txt", "literal $value; 'quoted'"),
            {"id": "digest", "op": "hash", "path": "${outputs.file.path}"},
        ])
        self.assertEqual(result["status"], "COMPLETED")
        content = "literal $value; 'quoted'".encode()
        self.assertEqual((self.workspace / "future directory/δ.txt").read_bytes(), content)
        self.assertEqual(result["results"][2]["sha256"], hashlib.sha256(content).hexdigest())

    def test_command_arguments_are_literal_and_logs_preserve_bytes(self):
        marker = self.workspace / "marker ; $x.txt"
        result = self.flow([self.command_step("execute", "--write", marker,
                                             "--content", "space ' quote $ ;",
                                             "--stdout-hex", "ff0061", "--stderr-hex", "fe62")])
        self.assertEqual(marker.read_text(), "space ' quote $ ;")
        row = result["results"][0]
        self.assertEqual(row["exitCode"], 0)
        self.assertEqual(Path(row["stdout"]).read_bytes(), b"\xff\x00a")
        self.assertEqual(Path(row["stderr"]).read_bytes(), b"\xfeb")

    def test_flow_environment_inherits_and_applies_declared_override(self):
        self.env["WR_CONTRACT_SENTINEL"] = "host sentinel"
        result = self.flow([
            self.command_step("inherited", "--print-env", "WR_CONTRACT_SENTINEL"),
            self.command_step("overridden", "--print-env", "WR_CONTRACT_SENTINEL",
                              env={"WR_CONTRACT_SENTINEL": "configured"}),
        ])
        self.assertEqual(Path(result["results"][0]["stdout"]).read_bytes(), b"host sentinel")
        self.assertEqual(Path(result["results"][1]["stdout"]).read_bytes(), b"configured")

    def test_failed_command_preserves_fact_and_continues_by_default(self):
        result = self.flow([self.command_step("bad", "--exit", 7),
                            self.write_step("after", "after.txt", "continued")])
        self.assertEqual(result["status"], "COMPLETED_WITH_OBSERVATIONS")
        self.assertEqual(result["results"][0]["exitCode"], 7)
        self.assertEqual((self.workspace / "after.txt").read_text(), "continued")

    def test_declared_stop_prevents_following_command(self):
        result = self.flow([self.command_step("bad", "--exit", 7, onError="stop"),
                            self.write_step("after", "after.txt")], expected=15)
        self.assertEqual(result["status"], "STOPPED")
        self.assertFalse((self.workspace / "after.txt").exists())

    def test_declared_retry_records_actual_attempts_only(self):
        first = self.flow([self.command_step("bad", "--exit", 9,
                                             retry={"maxAttempts": 2, "delayMs": 0})], expected=12)
        self.assertEqual(first["status"], "WAITING_RETRY")
        self.assertEqual(len(first["results"]), 0)
        final = self.resume()
        self.assertEqual(final["results"][0]["attempt"], 2)
        self.assertEqual(final["results"][0]["exitCode"], 9)
        self.assertEqual(len(self.state()["attemptHistory"]), 1)

    def test_timeout_retains_logs_and_observed_failure(self):
        result = self.flow([self.command_step("slow", "--sleep", 10, timeoutMs=80)])
        row = result["results"][0]
        self.assertTrue(row["timedOut"])
        self.assertEqual(row["status"], "failed")
        self.assertTrue(Path(row["stderr"]).is_file())

    def test_flow_timeout_terminates_the_spawned_process_group(self):
        marker = self.workspace / "child-survived"
        parent_ready, child_ready = self.root / "parent-ready", self.root / "child-ready"
        started_ns = time.monotonic_ns()
        result = self.flow([self.command_step("group", "--child-marker", marker,
                                             "--ready-marker", parent_ready, "--child-ready", child_ready,
                                             "--sleep", 10, timeoutMs=800)])
        returned_ns = time.monotonic_ns()
        self.assertTrue(parent_ready.is_file(), "Setup/inconclusive: parent never became ready")
        self.assertTrue(child_ready.is_file(), "Setup/inconclusive: descendant never became ready")
        parent, child = json.loads(parent_ready.read_text()), json.loads(child_ready.read_text())
        self.assertNotEqual(child["pid"], parent["pid"])
        self.assertEqual(child["pgid"], parent["pid"])
        self.assertEqual(parent["pgid"], parent["pid"])
        self.assertLess(started_ns, child["ready_ns"])
        self.assertLess(child["ready_ns"], returned_ns)
        self.assertTrue(result["results"][0]["timedOut"])
        time.sleep(1.8)
        self.assertFalse(marker.exists(), "Flow timeout must terminate descendants in its process group")

    def test_descendant_control_survives_direct_child_only_termination(self):
        marker, ready = self.root / "control-late-effect", self.root / "control-ready"
        process = subprocess.Popen([sys.executable, "-I", "-B", str(FIXTURE),
                                    "--child-marker", str(marker), "--child-ready", str(ready),
                                    "--sleep", "10"], start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "Setup/inconclusive: control descendant never became ready")
            child = json.loads(ready.read_text())
            self.assertEqual(child["pgid"], process.pid)
            process.terminate()  # Test-owned negative control, never the product.
            process.wait(timeout=2)
            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), "Direct-child-only control must retain the descendant effect")
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=2)

    def test_current_answer_does_not_apply_to_future_steps(self):
        (self.workspace / "a").write_text("old a")
        (self.workspace / "b").write_text("old b")
        first = self.flow([self.write_step("a", "a", "new a"),
                           self.write_step("b", "b", "new b")], expected=10)
        identifier = first["decisionRequest"]["requestId"]
        second = self.answer("flow", "decide", "--session", self.session,
                             "--request", identifier, "--choice", "overwrite", expected=10)
        self.assertEqual((self.workspace / "a").read_text(), "new a")
        self.assertEqual((self.workspace / "b").read_text(), "old b")
        self.assertNotEqual(second["decisionRequest"]["requestId"], identifier)
        self.assertEqual(second["currentStep"], "b")

    def test_presented_and_status_do_not_repeat_the_question(self):
        (self.workspace / "a").write_text("old")
        first = self.flow([self.write_step("a", "a")], expected=10)
        identifier = first["decisionRequest"]["requestId"]
        self.answer("flow", "presented", "--session", self.session,
                    "--request", identifier, expected=10)
        result = self.answer("flow", "status", "--session", self.session, expected=10)
        self.assertFalse(result["questionNeeded"])
        self.assertEqual(result["decisionRequest"]["requestId"], identifier)
        self.assertEqual((self.workspace / "a").read_text(), "old")

    def test_terminal_resume_does_not_repeat_side_effect(self):
        result = self.flow([self.write_step("file", "one.txt", "first")])
        (self.workspace / "one.txt").write_text("operator changed")
        replay = self.resume()
        self.assertEqual(replay["sessionId"], result["sessionId"])
        self.assertEqual(len(replay["results"]), 1)
        self.assertEqual((self.workspace / "one.txt").read_text(), "operator changed")

    def test_other_schema_fails_before_a_command_effect(self):
        self.flow([self.write_step("file", "forbidden")],
                  schema="workspace-recover/flow/v2", expected=1)
        self.assertFalse((self.workspace / "forbidden").exists())

    def test_duplicate_step_id_fails_before_first_effect(self):
        self.flow([self.write_step("same", "first"), self.write_step("same", "second")], expected=1)
        self.assertFalse((self.workspace / "first").exists())

    def test_saved_v3_state_is_read_without_rewriting_the_primary(self):
        self.session.mkdir()
        state = {"schema": "workspace-recover/flow-state/v3", "sessionId": "fixture-session",
                 "directory": str(self.session), "workspace": str(self.workspace),
                 "status": "COMPLETED", "cursor": 1, "manifest": {"steps": [{"id": "kept", "op": "write"}]},
                 "pending": None, "hostRequest": None, "notBefore": None, "observations": [],
                 "results": [{"id": "kept", "status": "passed", "path": "preserved-δ"}]}
        target = self.session / "state.json"
        target.write_text(json.dumps(state, ensure_ascii=False) + "\n")
        before = target.read_bytes()
        result = self.answer("flow", "status", "--session", self.session)
        self.assertEqual(result["sessionId"], "fixture-session")
        self.assertEqual(result["results"], state["results"])
        self.assertEqual(target.read_bytes(), before)


class ArchiveContracts(CliContract):
    def test_archive_restore_preserves_independent_bytes_and_modes(self):
        source = self.workspace / "original"
        source.mkdir()
        (source / "δ.txt").write_bytes(b"independent\x00bytes\xff")
        (source / "δ.txt").chmod(0o640)
        result = self.flow([{"id": "pack", "op": "archive", "from": "original", "to": "bundle.tar.gz"},
                            {"id": "restore", "op": "extract", "from": "bundle.tar.gz", "to": "restored"}])
        self.assertEqual(result["status"], "COMPLETED")
        target = self.workspace / "restored/δ.txt"
        self.assertEqual(target.read_bytes(), b"independent\x00bytes\xff")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)

    def test_archive_path_traversal_cannot_write_outside_target(self):
        archive = self.workspace / "bad.tar.gz"
        with tarfile.open(archive, "w:gz", format=tarfile.USTAR_FORMAT) as stream:
            entry = tarfile.TarInfo("../escaped")
            entry.size = 4
            stream.addfile(entry, io.BytesIO(b"evil"))
        result = self.flow([{"id": "extract", "op": "extract", "from": "bad.tar.gz", "to": "out"}])
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertFalse((self.workspace / "escaped").exists())

    def test_archive_output_inside_source_does_not_truncate_existing_bytes(self):
        source = self.workspace / "tree"
        source.mkdir()
        output = source / "keep.tar.gz"
        output.write_bytes(b"previous archive")
        result = self.flow([{"id": "pack", "op": "archive", "from": "tree", "to": "tree/keep.tar.gz",
                             "existingTarget": "overwrite"}])
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertEqual(output.read_bytes(), b"previous archive")


class TemplateProfileContracts(CliContract):
    def test_template_render_keeps_typed_values_and_input_layers(self):
        template = self.document("template.json", {
            "schema": "workspace-recover/template/v3", "name": "independent",
            "inputs": {"count": {"type": "integer", "default": 2},
                       "label": {"type": "string", "default": "default"}},
            "manifest": {"schema": "workspace-recover/manifest/v3",
                         "count": "${count}", "label": "value=${label}"}})
        values = self.document("values.json", {"schema": "workspace-recover/values/v3",
                                               "values": {"label": "from file"}})
        output = self.root / "rendered.json"
        self.invoke("template", "render", template, "--values", values,
                    "--set", "label=from CLI", "--output", output)
        self.assertEqual(json.loads(output.read_text()),
                         {"schema": "workspace-recover/manifest/v3", "count": 2,
                          "label": "value=from CLI"})

    def test_template_missing_fields_are_one_reported_batch(self):
        template = self.document("template.json", {
            "schema": "workspace-recover/template/v3", "name": "missing",
            "inputs": {"a": {"required": True}, "b": {"required": True}},
            "manifest": {"a": "${a}", "b": "${b}"}})
        output = self.root / "must-not-exist.json"
        result = self.invoke("template", "render", template, "--output", output, expected=1)
        self.assertIn(b'"missing":["a","b"]', result.stderr.replace(b" ", b""))
        self.assertFalse(output.exists())

    def test_profile_creation_is_exclusive_and_can_be_read(self):
        values = self.document("profile.json", {"schema": "workspace-recover/values/v3",
                                                "values": {"workspaceRoot": str(self.workspace)}})
        self.invoke("profile", "create", "local", "--values", values)
        result = self.answer("profile", "show", "local")
        self.assertEqual(result["workspaceRoot"], str(self.workspace))
        target = self.root / "config/profiles/local.json"
        before = target.read_bytes()
        self.invoke("profile", "create", "local", "--values", values, expected=1)
        self.assertEqual(target.read_bytes(), before)


class BridgeContracts(CliContract):
    def initialize(self, operations=None):
        bridge = self.root / "bridge"
        declaration = self.document("capabilities.json", {
            "schema": "workspace-recover/bridge-capabilities/v3",
            "account": "contract@example.test", "operations": operations or ["drive.metadata"]})
        self.answer("bridge", "init", "--bridge", bridge, "--capabilities", declaration)
        return bridge

    def test_bridge_identity_is_exclusive_and_pending_read_has_no_effect(self):
        bridge = self.initialize()
        before = (bridge / "capabilities.json").read_bytes()
        pending = self.answer("bridge", "pending", "--bridge", bridge, "--json")
        self.assertEqual(pending["requests"], [])
        self.invoke("bridge", "init", "--bridge", bridge,
                    "--capabilities", self.root / "capabilities.json", expected=1)
        self.assertEqual((bridge / "capabilities.json").read_bytes(), before)

    def test_host_request_waits_without_provider_call(self):
        bridge = self.initialize()
        manifest = self.document("host.json", {"schema": "workspace-recover/flow/v3", "steps": [
            {"id": "metadata", "op": "host", "operation": "drive.metadata", "payload": {"id": "fixture-id"}}]})
        result = self.answer("flow", "run", "--manifest", manifest, "--session", self.session,
                             "--workspace", self.workspace, "--bridge", bridge, expected=11)
        self.assertEqual(result["status"], "WAITING_HOST")
        self.assertFalse(result["questionNeeded"])
        pending = self.answer("bridge", "pending", "--bridge", bridge, "--json")
        self.assertEqual(len(pending["requests"]), 1)
        request = pending["requests"][0]
        self.assertEqual(request["operation"], "drive.metadata")
        self.assertEqual(request["payload"], {"id": "fixture-id", "flowStepId": "metadata",
                                              "flowAttempt": 1})
        self.assertEqual(request["account"], "contract@example.test")
        identity = {"sessionId": request["sessionId"], "account": "contract@example.test",
                    "operation": "drive.metadata", "payload": {"id": "fixture-id", "flowStepId": "metadata", "flowAttempt": 1}}
        expected = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(request["requestHash"], expected)
        self.assertEqual(request["requestId"], "rq_" + expected)

    def canonical_vector(self, name):
        vectors = json.loads((Path(__file__).parent / "fixtures/canonical_vectors.json").read_text())
        vector = vectors[name]
        bridge = self.initialize()
        manifest = self.document("vector.json", {"schema": "workspace-recover/flow/v3", "steps": [
            {"id": "metadata", "op": "host", "operation": "drive.metadata", "payload": vector["input"]}]})
        result = self.answer("flow", "run", "--manifest", manifest, "--session", self.session,
                             "--workspace", self.workspace, "--bridge", bridge, expected=11)
        request = result["hostRequest"]
        self.assertRegex(request["sessionId"], r"^[A-Za-z0-9_]+$")
        # Literal specification vector, not a call to the product/Python JSON canonicalizer.
        wire = ('{"account":"contract@example.test","operation":"drive.metadata","payload":'
                + vector["expected_payload"] + ',"sessionId":"' + request["sessionId"] + '"}')
        digest = hashlib.sha256(wire.encode("utf-8")).hexdigest()
        self.assertEqual(request["requestHash"], digest)
        self.assertEqual(request["requestId"], "rq_" + digest)
        identity = {key: request[key] for key in ("account", "operation", "payload", "sessionId")}
        naive = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertNotEqual(naive, wire, "Vector must discriminate the rejected Python sort_keys encoder")

    def test_canonical_numeric_spelling_vector(self):
        self.canonical_vector("numbers")

    def test_canonical_unicode_and_utf16_order_vector(self):
        self.canonical_vector("unicode")

    def test_unknown_host_outcome_is_reconciled_instead_of_resent(self):
        bridge = self.initialize(["drive.upload"])
        (self.workspace / "upload.bin").write_bytes(b"frozen upload")
        manifest = self.document("host.json", {"schema": "workspace-recover/flow/v3", "steps": [
            {"id": "upload", "op": "host", "operation": "drive.upload",
             "payload": {"file": "upload.bin", "folderId": "fixture-folder"}}]})
        self.answer("flow", "run", "--manifest", manifest, "--session", self.session,
                    "--workspace", self.workspace, "--bridge", bridge, expected=11)
        request = self.answer("bridge", "pending", "--bridge", bridge, "--json")["requests"][0]
        response = self.document("unknown.json", {"schema": "workspace-recover/connector-results/v3",
            "results": [{"requestId": request["requestId"], "requestHash": request["requestHash"],
                         "sessionId": request["sessionId"], "status": "unknown", "error": "host interrupted"}]})
        self.answer("bridge", "submit", "--bridge", bridge, "--results", response)
        result = self.resume(expected=10)
        self.assertEqual(result["decisionRequest"]["observation"]["code"], "REMOTE_OUTCOME_UNKNOWN")
        self.assertEqual(len(list((bridge / "requests").glob("*.json"))), 1)
        plan = self.answer("flow", "host-plan", "--session", self.session)
        self.assertEqual(plan["status"], "RECONCILE_HOST")
        self.assertTrue(all(call["tool"] != "Google_Drive.upload_file" for call in plan["calls"]))

    def test_mismatched_host_response_is_rejected_before_publication(self):
        bridge = self.initialize()
        manifest = self.document("host.json", {"schema": "workspace-recover/flow/v3", "steps": [
            {"id": "metadata", "op": "host", "operation": "drive.metadata", "payload": {"id": "fixture-id"}}]})
        self.answer("flow", "run", "--manifest", manifest, "--session", self.session,
                    "--workspace", self.workspace, "--bridge", bridge, expected=11)
        request = self.answer("bridge", "pending", "--bridge", bridge, "--json")["requests"][0]
        wrong = self.document("wrong.json", {"schema": "workspace-recover/connector-results/v3", "results": [
            {"requestId": request["requestId"], "requestHash": request["requestHash"],
             "sessionId": "wr_b_20000101000000_000000000000", "status": "completed", "result": {"id": "fixture-id"}}]})
        self.invoke("bridge", "submit", "--bridge", bridge, "--results", wrong, expected=1)
        self.assertEqual(list((bridge / "responses").glob("*.json")), [])


class LegacyBackupContracts(CliContract):
    def backup(self, workflow=None, **source_options):
        source = self.workspace / "source"
        source.mkdir()
        (source / "keep.txt").write_bytes(b"legacy payload\x00\xff")
        (source / "keep.txt").chmod(0o640)
        (source / "skip.txt").write_text("not selected")
        provider = {"type": "local-files", "root": str(self.root / "objects")}
        manifest = self.document("backup.json", {
            "schema": "workspace-recover/manifest/v3", "name": "external-contract",
            "backup": {"source": {"path": str(source), **source_options}, "provider": provider},
            "restore": {"workflow": workflow or []},
            "handoff": {"provider": provider, "to": ["contract@example.test"]}})
        process = self.invoke("backup", manifest)
        match = re.search(rb"Session: (wr_b_\d{14}_[a-f0-9]{12})", process.stdout)
        self.assertIsNotNone(match, process.stdout)
        identifier = match.group(1).decode()
        session = json.loads((self.root / "state/sessions" / identifier / "session.json").read_text())
        return identifier, session

    def test_local_backup_handoff_restore_and_full_info_path(self):
        identifier, session = self.backup(exclude=["skip.txt"])
        self.assertEqual(session["state"], "completed")
        self.assertEqual(session["result"]["recoveryRehearsal"], "success")
        handoff = Path(session["handoff"]["id"])
        index = json.loads((handoff / "workspace-handoff.json").read_text())
        self.assertEqual(index["schema"], "workspace-recover/handoff/v3")
        self.assertEqual(index["backupSessionId"], identifier)
        info = self.invoke("info", identifier, "--type", "backup", "--view", "full")
        primary = Path(info.stdout.decode().strip())
        self.assertTrue(primary.is_file())
        self.assertEqual(len(info.stdout.decode().splitlines()), 1)
        restored = self.root / "fresh restored"
        self.invoke("restore", handoff, "--target", restored)
        self.assertEqual((restored / "keep.txt").read_bytes(), b"legacy payload\x00\xff")
        self.assertEqual(stat.S_IMODE((restored / "keep.txt").stat().st_mode), 0o640)
        self.assertFalse((restored / "skip.txt").exists())

    def test_advisory_verification_keeps_raw_report_after_rehearsal(self):
        workflow = [{"id": "advisory", "type": "verification",
                     "argv": [sys.executable, "-I", "-c", "raise SystemExit(7)"]},
                    {"id": "after", "type": "command",
                     "argv": [sys.executable, "-I", "-c", "print('after advisory')"]}]
        identifier, session = self.backup(workflow)
        self.assertEqual(session["state"], "completed_with_warnings")
        self.assertEqual(session["result"]["verification"], "warnings")
        info = self.invoke("info", identifier, "--type", "step:advisory", "--view", "full")
        report = json.loads(Path(info.stdout.decode().strip()).read_text())
        self.assertEqual(report["exitCode"], 7)
        self.assertEqual(report["status"], "failed")

    def test_corrupt_archive_part_cannot_be_reported_as_restored(self):
        _, session = self.backup()
        handoff = Path(session["handoff"]["id"])
        transport = json.loads((handoff / "workspace-transport-manifest.json").read_text())
        Path(transport["parts"][0]["remote"]["id"]).write_bytes(b"corrupted")
        target = self.root / "must-not-restore"
        self.invoke("restore", handoff, "--target", target, expected=1)
        self.assertFalse((target / "keep.txt").exists())


class AuthStateContracts(CliContract):
    def test_auth_status_does_not_create_credentials_or_use_live_services(self):
        result = self.answer("auth", "status")
        self.assertEqual(result["profile"], "default")
        self.assertFalse(result["clientPresent"])
        self.assertFalse(result["tokenPresent"])
        self.assertEqual(self.answer("auth", "profiles"), [])
        self.assertFalse((self.root / "config/google-workspace").exists())

# External Python rewrite verification contract

This suite was authored from the accepted PYWR-DESIGN-V1 contract and existing
public formats/CLI declarations. It is not a translation of tests/*.test.mjs and
does not import WR business modules. Keep the JavaScript tests unchanged.

`WR_TEST_COMMAND_JSON` explicitly selects the subject command as a JSON argv
array; there is no JavaScript fallback. With no selection, the command is the
test interpreter followed by `-P -s -B -m workspace_recover`. That default needs
an actually installed candidate. A missing module or a runner/JSON parsing error
is an environment/inconclusive result, never meaningful RED.

Preservation checks deliberately remain GREEN on the old Node command. The
required new Python delivery declarations and changed permissions are tested
separately. Do not force old fulfilled behavior to fail.

## Old implementation, explicit preservation control

From the isolated WR source root:

```bash
WR_TEST_COMMAND_JSON='["node","/home/sbwerewolf/workdata/poise-project-data/workspace-recover/worktrees/WR-PYTHON-REWRITE-20261115/bin/workspace-recover.mjs"]' \
  /usr/bin/python3.12 -B -m unittest discover -s tests/python -p test_external_contract.py -v
```

Expected corrected baseline: all33 tests pass. They cover plain/failed/stopped/retried
flow, literal argv/raw logs/environment, group timeout, deferred paths, stable
choices/presented/terminal replay, independently authored saved-v3 status,
archive bytes/modes/path boundaries, local backup/handoff/rehearsal/restore,
corrupt parts, advisory reports, template layers/batches, exclusive profiles,
credential-free auth status and local host request binding/reconciliation.
Bridge scenarios publish only local fixture requests/responses; no connector,
Google API, browser or mail send is executed.

## New required behavior, unchanged product baseline

```bash
WR_TEST_COMMAND_JSON='["node","/home/sbwerewolf/workdata/poise-project-data/workspace-recover/worktrees/WR-PYTHON-REWRITE-20261115/bin/workspace-recover.mjs"]' \
  /usr/bin/python3.12 -B -m unittest discover -s tests/python -p test_new_contract.py -v

PYTHONPATH=/home/sbwerewolf/workdata/command-execution/src \
  /usr/bin/python3.12 -B -m unittest discover -s tests/python -p test_shared_io_contract.py -v
```

First command:4 expected assertion failures,1 preservation pass. Exact absent
properties are Python distribution metadata, an npm Python install hook, and
mode preservation on flow/template update. For the latter, content updates
succeed but modes0640 become0600/0644, discriminating a real product gap from
failed invocation. Missing metadata/hooks are explicit delivery assertions,
not exceptions caused by trying to import or execute absent code.

Second command:1 expected assertion failure for CE creating a new file and its
missing parent directories;3 current-contract passes for existing modes,
serialization failure and CE object/duplicate-key rejection. CE is explicitly
selected from source for this local baseline run. This is not a published or
installed CE distribution check. No test modifies that source repository.

## GREEN candidate, same assertions

After the accepted implementation provides a package-private environment with
the identified WR/CE candidates installed, run all files with that interpreter
and select its isolated Python entry explicitly:

```bash
WR_TEST_COMMAND_JSON='["/absolute/candidate/.venv/bin/python","-I","-B","-m","workspace_recover"]' \
  /absolute/candidate/.venv/bin/python -B -m unittest discover -s tests/python -p 'test_*.py' -v
```

The same38 WR/delivery checks,4 shared IO checks and8 shared API/delegation checks must all pass. Use the
candidate-installed CE on the runner's import path, not PYTHONPATH from an
unrelated checkout. Candidate wheel/local install identity must be recorded.
This does not substitute for the later integration/release checks of packed
resources, actual npm clean installation, public CE pin availability, Poise
shim/runtime preparation or actual publication; those require their produced
artifacts and real target owners. No npm/PyPI success follows from these tests.

## Oracles, artifacts and immutability

Expected bytes, modes, statuses, schema IDs and error classes are authored
literals from the Customer/design and versioned public formats. Archive input
for the traversal check is independently constructed with Python tarfile;
expected restored bytes are literal, never derived using WR's archive reader.
The connector SHA256 fixture uses hashlib on an explicit simple identity, not
WR's canonicalization function. The command-side fixture supplies deterministic
effects and raw bytes; it does not reproduce the recovery engine.

No expected output may be changed merely to match GREEN. Record any justified
contract change through the assigned reviewer. Product baseline and test hashes
are preserved at the test-gate artifact owner. Failed CLI scratch directories
are retained with raw stdout/stderr and their paths printed. The first authoring
run exposed two harness JSON/error assumptions and missing expected flow-binding
fields; those test-authoring mistakes were corrected before contract freeze and
are not product defects or RED evidence. Original logs remain at that owner.

## Scoped correction PYWR-T1: shared API and actual delegation

Run the additional shared contract file against an explicitly selected CE:

```bash
PYTHONPATH=/home/sbwerewolf/workdata/command-execution/src \
  /usr/bin/python3.12 -B -m unittest discover -s tests/python -p test_shared_api_contract.py -v
```

`ce_bindings.py` selects callable public CE seams without mandating their future
module/function names. Override only their dotted locations through the explicit
`CE_TEST_BINDINGS_JSON` object with roles read/write/prepare/execute/signal.
Record the effective object with the candidate identity; it is an input binding,
not permission to alter expected values. No behavioral adapter, identity
canonicalizer or fake backend is supplied. Functions must originate in
command_execution; selecting a test helper or a private WR implementation fails.
A nonexistent selected module is a setup ERROR and not meaningful RED.

The compatibility call contract is read(path, profile), execute(invocation,
options), and signal(handle, signal_name), with the accepted profile/options and
result/handle meanings. The default read/execute selections are the existing CE
compatibility functions, providing real callable absence controls: they reject
the newly required explicit profile/options calls. They are not an instruction
to remove their old default behavior. The implementation may supply distinct
new APIs and select them with the binding object; the existing CE reader/control
tests must still pass. The selected signal function is currently absent and
its callable assertion reports that exact selected capability gap. An absent
attribute is an assertion, not an attempted import of a fictional module.

inspect.signature.bind checks absence of the accepted public call shape before
invocation. A TypeError raised *inside* a shape-compatible candidate remains an
ERROR, not a relabeled RED assertion. Legacy controls still call the unchanged
old APIs with their old signatures; the new capability selection does not force
an already fulfilled compatibility behavior to fail.

Checks exercise both root/duplicate policies, explicit-profile omission,
malformed JSON, foreground actual exit7/raw bytes/exact environment, definite
launch failure, detached return before completion with real pid/pgid/readiness,
one-shot signal sent/absent, and a TERM-ignoring child proving no wait/escalation.
On the unchanged baseline,8 methods report expected capability assertions and
no ERROR. Detailed live semantics behind the absent entrypoints are candidate
checks, not claimed measured baseline behavior.

For actual WR delegation, delegation_driver.py patches those selected CE public
functions *before* importing the Python public CLI via runpy. Every wrapper
logs a bounded role/path/argv observation and forwards to the real CE function;
it implements no reader/process/write/prepare behavior and logs no environment
values or document bodies. The external flow must still produce its literal
marker, while traces must bind the actual input manifest to CE read, actual
state.json to CE write and actual fixture argv to CE prepare/execute. A private
WR reimplementation with only a dependency string produces no such trace and
fails. This needs the identified installed Python WR/CE candidate and its real
public binding locations. Current Python metadata absence is reported before
invoking that absent module; the baseline assertion is not claimed to prove
candidate call traces. Static ownership/no-duplicated-mechanism inspection and
the real installation checks remain their separate applicable obligations.

## Scoped corrections PYWR-T2/T3: sensitive preservation oracles

fixtures/canonical_vectors.json contains literal ECMAScript expected payload
bytes, independently authored from the accepted encoding contract/specification,
not calculated by WR or json.dumps. Numeric spelling includes1.0→1, -0→0,
1e-6→0.000001, 1e-7 and1e20/1e21 boundaries. Unicode includes raw Cyrillic/emoji
and UTF16 sort order (astral high surrogate sorts before U+E000, unlike Python
code-point order). The fixture inserts only the exposed ASCII session identity
into a fixed literal full request representation and hashes those UTF8 bytes.
Both external cases must pass the old CLI and must also assert that naive
json.dumps(sort_keys=True, ensure_ascii=False) produces different bytes. The
original ASCII control is unchanged. Specification basis: ECMAScript2024
JSON.stringify/Number::toString and default Array::sort string comparison,
https://262.ecma-international.org/15.0/ .

The group-timeout case now requires actual parent/descendant readiness records
with distinct positive pids, matching process group, and a descendant timestamp
within the observed run before interpreting absent delayed output. Missing
readiness is explicitly setup/inconclusive, not successful group termination.
The separate test-owned direct-child-only control proves that a ready descendant
does create its delayed marker when only its parent is terminated. This control
does not modify production. Together the positive precondition and contrasting
effect reject both never-launched and direct-child-only fake timeout behavior.
All test-owned control processes are bounded and cleaned by their own known group.

The V1 source tar/review findings at the artifact owner remain immutable.
Corrected checks use a new manifest, not a rewritten claim about old test bytes.

#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export WORKSPACE_RECOVER_PYTHON
WORKSPACE_RECOVER_PYTHON=$(command -v "${WORKSPACE_RECOVER_PYTHON:-python3}")

"$WORKSPACE_RECOVER_PYTHON" - <<'CHECK'
import json
import os
import tomllib
from pathlib import Path

python = tomllib.loads(Path("pyproject.toml").read_text())["project"]
npm = json.loads(Path("package.json").read_text())
assert (python["name"], python["version"]) == (npm["name"], npm["version"])
ref = os.environ.get("RELEASE_REF")
if ref and ref != "v" + python["version"]:
    raise SystemExit("Tag must match both distribution versions")
CHECK

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
"$WORKSPACE_RECOVER_PYTHON" -m venv "$scratch/build"
"$scratch/build/bin/python" -m pip install build==1.6.1 setuptools==84.2.1 wheel==0.48.0
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
mkdir -p dist
out=$PWD/dist
"$scratch/build/bin/python" -m build --wheel --no-isolation --outdir "$scratch"
wheel=("$scratch"/*.whl)
test "${#wheel[@]}" -eq 1
"$scratch/build/bin/python" -m pip install "${wheel[0]}"
"$scratch/build/bin/python" -m pip check
npm pack --ignore-scripts --pack-destination "$scratch"
archive=("$scratch"/*.tgz)
test "${#archive[@]}" -eq 1
export PIP_FIND_LINKS="$scratch ${PIP_FIND_LINKS:-}"
npm install --prefix "$scratch/npm" --no-audit --no-fund --foreground-scripts "${archive[0]}"
"$scratch/npm/node_modules/.bin/workspace-recover" --version
npm --prefix "$scratch/npm/node_modules/workspace-recover" test
cp -- "${wheel[0]}" "${archive[0]}" "$out/"

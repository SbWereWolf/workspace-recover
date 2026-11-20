# Package reference

## 1.1.10 — release automation

- Use the selected Python interpreter for backup rehearsal contract tests.
- Verify that the release tag belongs to `main` and allow GitHub Actions to retry an existing annotated tag.
- Compare an existing PyPI wheel with the built artifact and wait for npm validation before verifying and installing the published package.

## 1.1.9 — requirements and entry points

- Ubuntu/WSL; Python 3.12+ with venv/pip and Node.js 20+ for npm installation.
- Select Python through `WORKSPACE_RECOVER_PYTHON`; the Python project selects exact `command-execution==2.0.6`.
- Run `workspace-recover flow run` with a caller-owned v3 manifest and a session directory.
- Use `flow status` for saved results; `backup`, `restore`, `init` and session inspection have their own documented entry points.
- [Installation and working example](README.md); [operation reference](docs/flow.md); [release operations](docs/release-policy.md).

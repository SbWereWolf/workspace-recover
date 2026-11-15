# Package reference

## 1.0.1 — requirements and entry points

- Ubuntu/WSL; Python 3.11+ with venv/pip and Node.js 20+ for npm installation.
- Select Python through `WORKSPACE_RECOVER_PYTHON`; the Python project selects exact `command-execution==1.1.0`.
- Run `workspace-recover flow run` with a caller-owned v3 manifest and a session directory.
- Use `flow status` for saved results; `backup`, `restore`, `init` and session inspection have their own documented entry points.
- [Installation and working example](README.md); [operation reference](docs/flow.md); [release operations](docs/release-policy.md).

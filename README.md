# shell-server

Shared foundation for MCP Shell Server. This repo contains the core runtime,
server management layer, daemon IPC, tools, and security modules used by
interface layers (mcp-shell, VS Code extension, etc.).

## Install

```bash
npm install @mako10k/shell-server
```

## Run

```bash
npx -y @mako10k/shell-server
```

You can override the daemon socket and workspace namespace via flags or env vars.

```bash
shell-server --socket /tmp/mcp-shell/daemon.sock --cwd /path/to/repo --branch main
```

`--branch` is used for daemon socket namespace selection (not Git checkout branch selection).

Option precedence for socket path resolution:

- `--socket` (explicit socket path)
- `MCP_SHELL_DAEMON_SOCKET`
- auto-generated from `--cwd`/`MCP_SHELL_DAEMON_CWD` + `--branch`/`MCP_SHELL_DAEMON_BRANCH`

In other words, `--branch` affects the socket path only when an explicit socket path is not provided.

Default values (when options are omitted):

- `--cwd`: current process working directory (`process.cwd()`)
- `--branch`: `MCP_SHELL_DAEMON_BRANCH` -> `MCP_SHELL_SERVER_BRANCH` -> `main`
- `--socket`: `MCP_SHELL_DAEMON_SOCKET` or auto-generated as
	`$XDG_RUNTIME_DIR|os.tmpdir()/mcp-shell/<sha256(cwd)>/<branch>/daemon.sock`

## Build

```bash
npm install
npm run build
```

## Exports

- `@mako10k/shell-server/runtime`
- `@mako10k/shell-server/tool-runtime`

## Environment

- `MCP_SHELL_DAEMON_SOCKET` (socket path override)
- `MCP_SHELL_DAEMON_CWD` (working directory override)
- `MCP_SHELL_DAEMON_BRANCH` (branch namespace override)

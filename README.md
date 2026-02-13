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

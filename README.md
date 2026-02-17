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

### shell-server-cli

```bash
shell-server-cli [--socket <path>] [--cwd <path>] [--branch <name>] [subcmd [subcmd options]]
```

Subcmd (function name):

- `status`
- `info`
- `attach`
- `detach`
- `reattach`
- `stop`

Tool subcommand:

```bash
shell-server-cli [connection options] tool <tool-name> [--tool-option <value> ...]
```

AWS CLI-style extensions:

- `--input-json <json|@file>`: provide tool params as JSON object
- `--query <expr>`: filter JSON output with jq expression
	- engine order: `node-jq` -> system `jq` -> built-in simple query fallback

Examples:

```bash
shell-server-cli --branch main tool shell-execute --input-json '{"command":"echo hello","execution_mode":"foreground"}'
shell-server-cli --branch main tool shell-execute --command "echo hello" --execution-mode foreground --query '.result.stdout'
```

Help and schema inspection:

```bash
shell-server-cli --help
shell-server-cli tool help
shell-server-cli tool shell-execute --help
```

- `<tool-name>` accepts kebab-case and is converted to internal snake_case.
	- Example: `shell-execute` -> `shell_execute`
- tool options use `--kebab-case` and are converted to internal snake_case keys.
	- Example: `--working-directory` -> `working_directory`
- tool option values are parsed as JSON literals when possible; otherwise they are treated as strings.

Example:

```bash
shell-server-cli --branch main tool shell-execute --command "echo hello" --execution-mode "foreground"
```

`shell-server-cli` uses the same connection option resolution rules as `shell-server`.

## Build

```bash
npm install
npm run build
```

## Release

1. Update `CHANGELOG.md` (`[Unreleased]`) using Added / Changed / Fixed / Security / Dependencies / Notes.

Create next version section from `[Unreleased]`:

```bash
npm run changelog:release -- 0.1.1
```

Version bump (updates `package.json`, creates Git commit/tag):

```bash
npm run version:patch
npm run version:minor
npm run version:major
```

2. Push commit/tag to GitHub.

Publish:

```bash
npm publish
```

3. Create GitHub Release from the tag and copy the version section from `CHANGELOG.md`.

## Exports

- `@mako10k/shell-server/runtime`
- `@mako10k/shell-server/tool-runtime`

## Environment

- `MCP_SHELL_DAEMON_SOCKET` (socket path override)
- `MCP_SHELL_DAEMON_CWD` (working directory override)
- `MCP_SHELL_DAEMON_BRANCH` (branch namespace override)

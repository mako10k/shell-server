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
- `SHELL_SERVER_DAEMON_SOCKET`
- auto-generated from `--cwd`/`SHELL_SERVER_DAEMON_CWD` + `--branch`/`SHELL_SERVER_DAEMON_BRANCH`

In other words, `--branch` affects the socket path only when an explicit socket path is not provided.

Default values (when options are omitted):

- `--cwd`: current process working directory (`process.cwd()`)
- `--branch`: `SHELL_SERVER_DAEMON_BRANCH` -> `SHELL_SERVER_BRANCH` -> `main`
- `--socket`: `SHELL_SERVER_DAEMON_SOCKET` or auto-generated as
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
- `tool` (see Tool subcommand section below)
- `help`

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
shell-server-cli --branch main tool server-reattach --server-id '<server-id>' --config-updates '{"enhanced_mode_enabled":false,"llm_evaluation_enabled":false}'
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

Runtime config synchronization on reattach:

- `server_reattach` supports optional `config_updates` payload.
- Updates are applied daemon-side without restart.
- Invalid payloads return explicit validation errors (e.g. `invalid_config_payload:*`).
- `info` response includes `configVersion` for effective daemon config tracking.

## Breaking Changes (v0.2.0)

`v0.2.0` includes intentional breaking changes to remove MCP-specific naming from generic server components.

- Env var prefix changed from `MCP_SHELL_*` to `SHELL_SERVER_*`.
- Child daemon socket file changed from `mcp.sock` to `child.sock`.
- Server/daemon info field changed from `mcpSocketPath` to `childSocketPath`.
- Runtime error export changed from `MCPShellError` to `ShellServerError`.

No backward-compatible fallback is provided in `v0.2.0`.
Update all existing environment variables and client-side field references before upgrading.

## Build

```bash
npm install
npm run build
```

## Release

Stable release checklist (short version):

1. Update `CHANGELOG.md` (`[Unreleased]`) and split next version section.

```bash
npm run changelog:release -- <version>
```

2. Run pre-commit quality checks.

```bash
npm install
npm run build
npm audit
npm run test:e2e
```

3. Bump version (SemVer) without auto tag/commit.

```bash
npm version patch --no-git-tag-version
# or: npm version minor --no-git-tag-version
# or: npm version major --no-git-tag-version
```

4. Commit release changes and create annotated tag.

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): <version>"
git tag -a v<version> -m "Release v<version>"
```

5. Push branch and tag.

```bash
git push origin main
git push origin v<version>
```

6. Publish package and update GitHub Release.

```bash
npm publish
gh release create v<version> --title "v<version>" --generate-notes
# if release already exists:
gh release edit v<version> --title "v<version>" --notes-file <release-note-file>
```

Detailed fixed procedure for automation/Copilot is documented in `.github/copilot-instruction.md`.

## Exports

- `@mako10k/shell-server/runtime`
- `@mako10k/shell-server/tool-runtime`

## Environment

- `SHELL_SERVER_DAEMON_SOCKET` (socket path override)
- `SHELL_SERVER_DAEMON_CWD` (working directory override)
- `SHELL_SERVER_DAEMON_BRANCH` (branch namespace override)

## Evaluator Errors (HTTP Analogy)

When `shell_execute` uses the enhanced evaluator, daemon/tool errors include structured
`evaluator_error` metadata. These codes use an HTTP-style analogy for quick triage.

- `EVALUATOR_CONTRACT_MISMATCH` -> `409 Conflict`
	- Meaning: prompt/tool contract is inconsistent (deterministic client/runtime bug)
	- Retry: no
	- Daemon behavior: may detach current attached client (`disconnectClient: true`)
- `EVALUATOR_TOOL_ARGS_INVALID` -> `422 Unprocessable Content`
	- Meaning: model returned malformed tool arguments
	- Retry: yes
	- Daemon behavior: keep connection
- `EVALUATOR_LLM_NO_TOOL_CALL` -> `502 Bad Gateway`
	- Meaning: model failed to return required function/tool call
	- Retry: yes
	- Daemon behavior: keep connection
- `EVALUATOR_PROVIDER_UNAVAILABLE` -> `503 Service Unavailable`
	- Meaning: upstream model provider or adapter unavailable
	- Retry: yes
	- Daemon behavior: keep connection
- `EVALUATOR_TIMEOUT` -> `504 Gateway Timeout`
	- Meaning: evaluator timed out / max internal retries reached
	- Retry: yes
	- Daemon behavior: keep connection
- `EVALUATOR_INTERNAL_ERROR` -> `500 Internal Server Error`
	- Meaning: unexpected evaluator-side fault
	- Retry: usually no
	- Daemon behavior: keep connection

Notes:

- Security remains fail-closed for command execution (`deny` on evaluator failure).
- Daemon process remains alive; only the affected client session may be detached for
	non-retryable contract mismatch.

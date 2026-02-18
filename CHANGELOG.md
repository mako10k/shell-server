# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- Features added in CLI / daemon / runtime / tools

### Changed
- Changes to existing behavior (explicitly note compatibility impact when applicable)

### Fixed
- Bug fixes (briefly note reproduction conditions and impact scope)

### Security
- Security-related fixes and evaluation rule updates

### Dependencies
- Major dependency updates (include rationale when applicable)

### Notes
- Release notes and supplements (migration steps, known limitations, etc.)

## [0.2.4] - 2026-02-18

### Changed
- Translated remaining Japanese comments in source files to English for consistent maintainability.
- Standardized release/changelog wording in English and aligned changelog automation placeholders.

### Notes
- Added operational rollback policy to preserve user value and require explicit approval before broad rollback.

## [0.2.3] - 2026-02-18

### Fixed
- Fixed `createMessageCallbackFromMCPServer` so text is safely extracted from MCP SDK response `content` even when it is a union including arrays/non-text values, resolving the `prepublishOnly` build error.

### Security
- Resolved vulnerabilities (high/moderate) detected by `npm audit`.

### Dependencies
- Updated `@modelcontextprotocol/sdk` to `^1.26.0` and aligned related dependencies (`ajv`, etc.) to vulnerability-fixed versions.

## [0.2.2] - 2026-02-18

### Fixed
- Added fallback behavior so `shell-server-cli` auto-starts and reconnects when the daemon socket is not running.
- Changed daemon idle-shutdown criteria to use “subscribed resources,” reflecting file subscription flags and terminal paging position.
- Unified timeout behavior so running processes with subscribed resources use the same timeout (default 3 hours) as running processes without subscribed resources.

## [0.2.1] - 2026-02-18

### Fixed
- Added a shebang to the `shell-server` entry point, fixing shell-interpretation issues during `npm link` / global execution.
- Strengthened daemon `SIGINT` / `SIGTERM` handling to ensure reliable process termination after shutdown completion.
- Stopped `MonitoringManager` system monitoring timers in `cleanup()`, fixing exit failures caused by event-loop residue.

## [0.2.0] - 2026-02-17

### Changed
- **Breaking:** Unified environment variable prefixes across daemon / CLI / server-manager / security / process-manager from `MCP_SHELL_*` to `SHELL_SERVER_*`.
- **Breaking:** Renamed daemon child socket from `mcp.sock` to `child.sock`.
- **Breaking:** Renamed child socket field in daemon `info` response and `ServerInfo` from `mcpSocketPath` to `childSocketPath`.
- **Breaking:** Renamed runtime export error from `MCPShellError` to `ShellServerError` (reference name changed via `@mako10k/shell-server/tool-runtime`).

### Fixed
- Fixed a startup path where only `daemon.sock` was created (without `mcp.sock`) when launched via `mcp-shell`, and strengthened child daemon entry resolution.

### Notes
- Legacy environment-variable fallback for backward compatibility is **not supported** (intentional breaking change).
- If you are using legacy settings, replace with the new names below.
	- `MCP_SHELL_DAEMON_SOCKET` -> `SHELL_SERVER_DAEMON_SOCKET`
	- `MCP_SHELL_DAEMON_CWD` -> `SHELL_SERVER_DAEMON_CWD`
	- `MCP_SHELL_DAEMON_BRANCH` -> `SHELL_SERVER_DAEMON_BRANCH`
	- `MCP_SHELL_SERVER_BRANCH` -> `SHELL_SERVER_BRANCH`
	- `MCP_SHELL_DAEMON_ENTRY` -> `SHELL_SERVER_DAEMON_ENTRY`
	- `MCP_SHELL_DAEMON_ENABLED` -> `SHELL_SERVER_DAEMON_ENABLED`
	- `MCP_SHELL_MCP_DAEMON_ENTRY` / `MCP_SHELL_CHILD_DAEMON_ENTRY` -> `SHELL_SERVER_CHILD_DAEMON_ENTRY`
	- `MCP_SHELL_DEFAULT_WORKDIR` -> `SHELL_SERVER_DEFAULT_WORKDIR`
	- `MCP_SHELL_ALLOWED_WORKDIRS` -> `SHELL_SERVER_ALLOWED_WORKDIRS`
	- `MCP_SHELL_ENABLE_STREAMING` -> `SHELL_SERVER_ENABLE_STREAMING`
	- `MCP_SHELL_SECURITY_MODE` -> `SHELL_SERVER_SECURITY_MODE`
	- `MCP_SHELL_MAX_EXECUTION_TIME` -> `SHELL_SERVER_MAX_EXECUTION_TIME`
	- `MCP_SHELL_MAX_MEMORY_MB` -> `SHELL_SERVER_MAX_MEMORY_MB`
	- `MCP_SHELL_ENABLE_NETWORK` -> `SHELL_SERVER_ENABLE_NETWORK`
	- `MCP_SHELL_ENHANCED_MODE` -> `SHELL_SERVER_ENHANCED_MODE`
	- `MCP_SHELL_LLM_EVALUATION` -> `SHELL_SERVER_LLM_EVALUATION`
	- `MCP_SHELL_SKIP_SAFE_COMMANDS` -> `SHELL_SERVER_SKIP_SAFE_COMMANDS`
	- `MCP_SHELL_ENABLE_PATTERN_FILTERING` -> `SHELL_SERVER_ENABLE_PATTERN_FILTERING`
	- `MCP_SHELL_ELICITATION` -> `SHELL_SERVER_ELICITATION`
	- `MCP_SHELL_BASIC_SAFE_CLASSIFICATION` -> `SHELL_SERVER_BASIC_SAFE_CLASSIFICATION`
	- `MCP_SHELL_LLM_PROVIDER` -> `SHELL_SERVER_LLM_PROVIDER`
	- `MCP_SHELL_LLM_MODEL` -> `SHELL_SERVER_LLM_MODEL`
	- `MCP_SHELL_LLM_API_KEY` -> `SHELL_SERVER_LLM_API_KEY`
	- `MCP_SHELL_LLM_TIMEOUT` -> `SHELL_SERVER_LLM_TIMEOUT`

## [0.1.1] - 2026-02-17

### Added
- Added a helper script: `npm run changelog:release -- <version>` to generate the next version heading from `[Unreleased]`.

## [0.1.0] - 2026-02-17

### Added
- Initial npm release of `@mako10k/shell-server`.

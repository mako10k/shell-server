# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- CLI / daemon / runtime / tool で追加した機能

### Changed
- 既存挙動の変更（互換性に影響する場合は明記）

### Fixed
- 不具合修正（再現条件や影響範囲を短く記載）

### Security
- セキュリティ関連の修正・評価ルール更新

### Dependencies
- 主要依存関係の更新（理由があれば記載）

### Notes
- リリース時の補足（移行手順、既知の制約など）

## [0.2.2] - 2026-02-18

### Fixed
- `shell-server-cli` が daemon ソケット未起動時に自動起動して再接続するフォールバックを追加。
- daemon のアイドル停止判定を「購読済みリソース」基準へ変更し、ファイル購読フラグおよびターミナルページング位置を反映。
- 実行中かつ購読済みリソースありのケースを、実行中かつ購読済みリソースなしと同じタイムアウト（既定3時間）で停止するよう統一。

## [0.2.1] - 2026-02-18

### Fixed
- `shell-server` エントリーポイントに shebang を追加し、`npm link` / グローバル実行時にシェル解釈される不具合を修正。
- daemon の `SIGINT` / `SIGTERM` ハンドリングを強化し、シャットダウン完了後に確実にプロセス終了するよう修正。
- `MonitoringManager` のシステム監視タイマーを `cleanup()` で停止し、イベントループ残留で終了できない不具合を修正。

## [0.2.0] - 2026-02-17

### Changed
- **Breaking:** daemon / CLI / server-manager / security / process-manager の環境変数プレフィックスを `MCP_SHELL_*` から `SHELL_SERVER_*` へ統一。
- **Breaking:** daemon の子ソケット名を `mcp.sock` から `child.sock` に変更。
- **Breaking:** daemon `info` 応答および `ServerInfo` で返す子ソケット項目を `mcpSocketPath` から `childSocketPath` に変更。
- **Breaking:** runtime export のエラー名を `MCPShellError` から `ShellServerError` に変更（`@mako10k/shell-server/tool-runtime` 経由の参照名が変更）。

### Fixed
- `mcp-shell` 経由起動時に `daemon.sock` のみ作成されて `mcp.sock` が作成されない経路を修正し、子 daemon エントリ解決を強化。

### Notes
- 互換性維持のための旧環境変数 fallback は **非対応**（意図的な破壊的変更）。
- 旧設定を使用している場合は、以下を新名称へ置換してください。
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
- `npm run changelog:release -- <version>` で `[Unreleased]` から次バージョン見出しを生成できる補助スクリプトを追加

## [0.1.0] - 2026-02-17

### Added
- Initial npm release of `@mako10k/shell-server`.

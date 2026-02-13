# shell-server

Shared foundation for MCP Shell Server. This repo contains the core runtime,
server management layer, daemon IPC, tools, and security modules used by
interface layers (mcp-shell, VS Code extension, etc.).

## Build

```bash
npm install
npm run build
```

## Exports

- `@mako10k/shell-server/runtime`
- `@mako10k/shell-server/tool-runtime`

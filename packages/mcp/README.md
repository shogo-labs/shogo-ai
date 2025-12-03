# @shogo/mcp

> MCP server for Claude integration with Shogo state management

16 tools across 5 namespaces providing schema lifecycle, CRUD operations, views, and conversational AI. Runs as stdio server or HTTP endpoint.

## Quick Start

```bash
cd packages/mcp

# Stdio transport (Claude Code)
bun run start

# HTTP endpoint
bun run start:http

# Development with FastMCP inspector
bun run dev
```

## Scripts

```bash
bun run build       # Build to dist/
bun run dev         # FastMCP dev server
bun run start       # Stdio server
bun run start:http  # HTTP server
bun run test        # Run tests
bun run typecheck   # Type check
```

## Tool Namespaces

| Namespace | Tools | Purpose |
|-----------|-------|---------|
| `schema.*` | 4 | Schema lifecycle (set, get, load, list) |
| `store.*` | 5 | Entity CRUD (create, get, list, update, models) |
| `view.*` | 4 | Queries and projection (execute, project, define, delete) |
| `data.*` | 2 | Bulk loading (load, loadAll) |
| `agent.*` | 1 | Conversational interface (chat) |

## Architecture

```
src/
├── server.ts       # Stdio transport
├── server-http.ts  # HTTP transport
├── tools/          # 16 tool implementations
└── state.ts        # Shared runtime state
```

## Documentation

- [MCP Tools Reference](../../docs/api/MCP_TOOLS.md)
- [Getting Started](../../docs/GETTING_STARTED.md)

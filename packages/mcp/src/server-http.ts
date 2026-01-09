import { FastMCP } from "fastmcp"
import { join } from "node:path"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend, isPostgresAvailable, isSqliteAvailable } from "./postgres-init"
import { initializeDomainSchemas } from "./ddl-init"
import { initializeSeedData } from "./seed-init"

// Port configuration from environment (supports multi-worktree isolation)
const MCP_PORT = parseInt(process.env.MCP_PORT || '3100', 10)

// Schemas path - use SCHEMAS_PATH env var (Docker) or default to monorepo .schemas (local dev)
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || join(import.meta.dir, "../../../.schemas")
console.log(`[mcp] Schemas path: ${SCHEMAS_PATH}`)

// Initialize PostgreSQL backend from DATABASE_URL (if available)
await initializePostgresBackend()

// Initialize DDL for domain schemas with postgres backend
await initializeDomainSchemas(SCHEMAS_PATH)

// Initialize seed data (Shogo org, Platform project)
await initializeSeedData(SCHEMAS_PATH)

// Wavesmith MCP with HTTP/SSE transport
const server = new FastMCP({
  name: "wavesmith-mcp",
  version: "0.0.1",
})

// Register all Wavesmith tools (18 tools)
registerAllTools(server)

// Start with HTTP streaming transport (provides both /mcp and /sse endpoints)
server.start({
  transportType: "httpStream",
  httpStream: {
    port: MCP_PORT,
    endpoint: "/mcp",
    // Stateful mode (default) - enables session tracking for streaming notifications
    // Client must include mcp-session-id header on subsequent requests
  },
})

console.log(`Wavesmith MCP HTTP server running on http://localhost:${MCP_PORT}`)
console.log(`HTTP Stream endpoint: http://localhost:${MCP_PORT}/mcp`)
console.log(`SSE endpoint: http://localhost:${MCP_PORT}/sse`)
console.log(`SQL backend: ${isPostgresAvailable() ? "postgres" : isSqliteAvailable() ? "sqlite" : "memory only"}`)

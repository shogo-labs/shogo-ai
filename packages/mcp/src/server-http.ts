import { FastMCP } from "fastmcp"
import { join } from "node:path"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend, isPostgresAvailable, isSqliteAvailable } from "./postgres-init"
import { initializeDomainSchemas } from "./ddl-init"
import { initializeSeedData } from "./seed-init"
import { preloadCoreSchemas } from "./schema-preload"

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

// Pre-load core schemas into meta-store at startup
// This ensures schemas are available immediately for queries without waiting for browser schema.load calls
await preloadCoreSchemas(SCHEMAS_PATH)

// Wavesmith MCP with HTTP/SSE transport
const server = new FastMCP({
  name: "wavesmith-mcp",
  version: "0.0.1",
})

// Register all Wavesmith tools (18 tools)
registerAllTools(server)

// Health check endpoint for Kubernetes probes
// This runs on a separate Bun server since FastMCP doesn't support custom routes
const healthServer = Bun.serve({
  port: MCP_PORT + 1,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/ready") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`[mcp] Health check endpoint: http://0.0.0.0:${MCP_PORT + 1}/health`)

// Start with HTTP streaming transport (provides both /mcp and /sse endpoints)
server.start({
  transportType: "httpStream",
  httpStream: {
    port: MCP_PORT,
    endpoint: "/mcp",
    // Bind to 0.0.0.0 for Docker/Kubernetes (allows external connections)
    host: "0.0.0.0",
    // Stateful mode (default) - enables session tracking for streaming notifications
    // Client must include mcp-session-id header on subsequent requests
  },
})

console.log(`Wavesmith MCP HTTP server running on http://0.0.0.0:${MCP_PORT}`)
console.log(`HTTP Stream endpoint: http://localhost:${MCP_PORT}/mcp`)
console.log(`SSE endpoint: http://localhost:${MCP_PORT}/sse`)
console.log(`SQL backend: ${isPostgresAvailable() ? "postgres" : isSqliteAvailable() ? "sqlite" : "memory only"}`)

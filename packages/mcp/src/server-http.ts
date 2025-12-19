import { FastMCP } from "fastmcp"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend, isPostgresAvailable } from "./postgres-init"

// Initialize PostgreSQL backend from DATABASE_URL (if available)
initializePostgresBackend()

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
    port: 3100,
    endpoint: "/mcp",
    // Stateful mode (default) - enables session tracking for streaming notifications
    // Client must include mcp-session-id header on subsequent requests
  },
})

console.log("Wavesmith MCP HTTP server running on http://localhost:3100")
console.log("HTTP Stream endpoint: http://localhost:3100/mcp")
console.log("SSE endpoint: http://localhost:3100/sse")
console.log(`PostgreSQL backend: ${isPostgresAvailable() ? "connected" : "unavailable (memory only)"}`)

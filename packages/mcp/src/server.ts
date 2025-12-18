import { FastMCP } from "fastmcp"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend } from "./postgres-init"

// Initialize PostgreSQL backend from DATABASE_URL (if available)
initializePostgresBackend()

// Wavesmith MCP (stdio transport for Claude Code sessions)
const server = new FastMCP({
  name: "wavesmith-mcp",
  version: "0.0.1",
})

// Register all Wavesmith tools (18 tools)
registerAllTools(server)
server.start({
  transportType: "stdio",
})

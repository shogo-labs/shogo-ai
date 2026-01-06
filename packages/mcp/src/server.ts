import { FastMCP } from "fastmcp"
import { join } from "node:path"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend } from "./postgres-init"
import { initializeDomainSchemas } from "./ddl-init"
import { initializeSeedData } from "./seed-init"

// Initialize PostgreSQL backend from DATABASE_URL (if available)
await initializePostgresBackend()

// Initialize DDL for domain schemas with postgres backend
await initializeDomainSchemas(join(import.meta.dir, "../../../.schemas"))

// Initialize seed data (Shogo org, Platform project) after DDL
await initializeSeedData(join(import.meta.dir, "../../../.schemas"))

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

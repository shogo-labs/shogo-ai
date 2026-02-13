import { FastMCP } from "fastmcp"
import { join } from "node:path"
import { registerAllTools } from "./tools/registry"
import { initializePostgresBackend } from "./postgres-init"
import { initializeDomainSchemas } from "./ddl-init"
import { initializeSeedData } from "./seed-init"
import { preloadCoreSchemas } from "./schema-preload"

const SCHEMAS_PATH = join(import.meta.dir, "../../../.schemas")

// Initialize PostgreSQL backend from DATABASE_URL (if available)
await initializePostgresBackend()

// Initialize DDL for domain schemas with postgres backend
await initializeDomainSchemas(SCHEMAS_PATH)

// Initialize seed data (Shogo org, Platform project) after DDL
await initializeSeedData(SCHEMAS_PATH)

// Pre-load core schemas into meta-store at startup
await preloadCoreSchemas(SCHEMAS_PATH)

// Shogo MCP (stdio transport for Claude Code sessions)
const server = new FastMCP({
  name: "shogo-mcp",
  version: "0.0.1",
})

// Register all Shogo tools (18 tools)
registerAllTools(server)
server.start({
  transportType: "stdio",
})

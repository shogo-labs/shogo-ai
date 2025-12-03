import { FastMCP } from "fastmcp"
import { registerAllTools } from "./tools/registry"

// Wavesmith MCP (stdio transport for Claude Code sessions)
const server = new FastMCP({
  name: "wavesmith-mcp",
  version: "0.0.1",
})

// Register all Wavesmith tools (15 tools)
registerAllTools(server)
server.start({
  transportType: "stdio",
})

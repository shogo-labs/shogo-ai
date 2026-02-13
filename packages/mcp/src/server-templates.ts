/**
 * Wavesmith MCP Server - Template Tools Only
 *
 * A minimal MCP server that only exposes template tools for the Shogo agent.
 * Used by project runtime for rapid app scaffolding via starter templates.
 *
 * Tools available:
 * - template.list: List and search available starter templates
 * - template.copy: Copy a template to set up a project
 * - image.save: Save user-attached images to project public/ directory
 */
import { FastMCP } from "fastmcp"
import { registerTemplateTools } from "./tools/registry"

// Wavesmith MCP (stdio transport for Claude Code sessions)
const server = new FastMCP({
  name: "wavesmith-templates",
  version: "0.0.1",
})

// Register template + image tools (3 tools)
registerTemplateTools(server)

server.start({
  transportType: "stdio",
})

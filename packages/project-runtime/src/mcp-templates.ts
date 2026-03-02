/**
 * Shogo MCP Server - Template Tools Only
 *
 * A minimal MCP server that exposes template tools for the Shogo agent.
 * Used by project runtime for rapid app scaffolding via starter templates.
 *
 * Tools available:
 * - template.list: List and search available starter templates
 * - template.copy: Copy a template to set up a project
 */
import { FastMCP } from "fastmcp"
import { registerTemplateTools } from "./tools/registry"

const server = new FastMCP({
  name: "shogo-templates",
  version: "0.0.1",
})

registerTemplateTools(server)

server.start({
  transportType: "stdio",
})

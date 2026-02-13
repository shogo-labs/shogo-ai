import { FastMCP } from "fastmcp"

// Template tools
import { registerTemplateList } from "./template.list"
import { registerTemplateCopy } from "./template.copy"

// Image tools
import { registerImageSave } from "./image.save"

/**
 * Register template tools on a FastMCP server instance.
 *
 * This provides access to starter templates for rapid app scaffolding.
 *
 * Total: 3 tools
 * - Template: 2 tools (list, copy)
 * - Image: 1 tool (save)
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerTemplateTools(server: FastMCP) {
  // Template namespace (2 tools) - for project scaffolding
  registerTemplateList(server)
  registerTemplateCopy(server)

  // Image namespace (1 tool) - for saving user-attached images
  registerImageSave(server)
}

// Keep backward-compatible exports pointing to the same function
export const registerPlatformTools = registerTemplateTools
export const registerProjectTools = registerTemplateTools
export const registerAllTools = registerTemplateTools

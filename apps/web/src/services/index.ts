/**
 * App-level MCP service instance
 *
 * Creates a singleton MCPService instance configured for this app.
 * Other modules import mcpService from here for MCP operations.
 */
import { MCPService } from '@shogo/app-core'

// Construct MCP URL from environment
// Use VITE_MCP_URL if explicitly set, otherwise use relative '/mcp' path
const mcpUrl = import.meta.env.VITE_MCP_URL
  ? `${import.meta.env.VITE_MCP_URL}/mcp`
  : '/mcp'

// Create singleton MCPService instance for app-wide use
export const mcpService = new MCPService({ baseUrl: mcpUrl })

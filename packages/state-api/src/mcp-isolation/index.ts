/**
 * MCP Isolation Module - Platform vs Project Tool Access
 *
 * Provides types for MCP separation: Platform MCP (singleton, all tools)
 * vs Project MCP (per-project, restricted tools).
 *
 * @example
 * ```typescript
 * import type { MCPContext, IPlatformMCP, IProjectMCP } from '@shogo/state-api/mcp-isolation'
 * import { DEFAULT_TOOL_ACCESS } from '@shogo/state-api/mcp-isolation'
 *
 * // Check tool access for context
 * const context: MCPContext = 'project'
 * const tools = context === 'platform'
 *   ? DEFAULT_TOOL_ACCESS.platformTools
 *   : DEFAULT_TOOL_ACCESS.projectTools
 * ```
 */

// Type exports
export type {
  MCPContext,
  IPlatformMCP,
  IProjectMCP,
  IToolAccessConfig,
  IMCPServer,
} from './types'

// Constants
export { DEFAULT_TOOL_ACCESS } from './types'

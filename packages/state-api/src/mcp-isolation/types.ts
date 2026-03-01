/**
 * MCP Isolation Types
 *
 * TypeScript interfaces for MCP separation: IPlatformMCP (singleton platform tools),
 * IProjectMCP (per-project tools). Defines which tools each context has access to
 * and schema restrictions.
 *
 * Pure types with no runtime imports following service-interface pattern.
 *
 * @see packages/mcp/src/tools/registry.ts for implementation
 */

/**
 * Generic MCP server interface that tools can be registered on.
 * This avoids a direct dependency on fastmcp in state-api.
 */
export interface IMCPServer {
  addTool(tool: unknown): void
}

/**
 * MCP context type - determines which set of tools are available.
 *
 * - 'platform': Full access to all 16 tools, all schemas (studio-core, platform-features, etc.)
 * - 'project': Restricted access - only workspace schemas, no DDL/agent/workspace.sync
 */
export type MCPContext = 'platform' | 'project'

/**
 * Platform MCP interface for singleton platform tools.
 *
 * Platform MCP provides full access to all Shogo tools for:
 * - Claude orchestration (AI-driven development)
 * - Schema management (DDL, migrations)
 * - Cross-project operations
 *
 * Accessible schemas:
 * - studio-core: Organizations, projects, project membership
 * - platform-features: Feature sessions, requirements, analysis findings
 * - component-builder: UI composition system
 * - studio-chat: Chat sessions and messages
 *
 * Available tools (all 16):
 * - Schema: set, load, list
 * - Store: create, get, update, delete, query
 * - View: execute, define, delete, project
 * - DDL: execute, migrate
 * - Agent: chat
 * - Workspace: sync
 */
export interface IPlatformMCP {
  /**
   * Register all platform tools on the MCP server.
   * Called once during MCP server initialization.
   *
   * @param server - MCP server instance (FastMCP or compatible)
   */
  registerTools(server: IMCPServer): void
}

/**
 * Project MCP interface for per-project tools.
 *
 * Project MCP provides restricted access for user workspace operations:
 * - Schema management (read/write user schemas only)
 * - Store CRUD operations
 * - View execution
 *
 * Schema restrictions:
 * - Can ONLY access user workspace schemas
 * - NO access to: studio-core, platform-features, component-builder, studio-chat
 *
 * Available tools (subset of 16):
 * - Schema: set, load, list (restricted to user workspace)
 * - Store: create, get, update, delete, query
 * - View: execute, project
 *
 * Excluded tools:
 * - DDL: execute, migrate (platform-only)
 * - Agent: chat (platform-only)
 * - Workspace: sync (platform-only)
 * - View: define, delete (platform-only)
 */
export interface IProjectMCP {
  /**
   * Register project-scoped tools on the MCP server.
   * Called when creating a project-specific MCP instance.
   *
   * @param server - MCP server instance (FastMCP or compatible)
   * @param projectId - Project ID for scoping operations
   */
  registerTools(server: IMCPServer, projectId: string): void
}

/**
 * Tool access configuration for each context.
 * Used by registry to determine which tools to register.
 */
export interface IToolAccessConfig {
  /** Tools available in platform context */
  platformTools: string[]
  /** Tools available in project context */
  projectTools: string[]
}

/**
 * Default tool access configuration.
 * Defines the split between platform and project tools.
 */
export const DEFAULT_TOOL_ACCESS: IToolAccessConfig = {
  platformTools: [
    // Schema namespace
    'schema.set',
    'schema.load',
    'schema.list',
    // Store namespace
    'store.create',
    'store.get',
    'store.update',
    'store.delete',
    'store.query',
    // View namespace
    'view.execute',
    'view.define',
    'view.delete',
    'view.project',
    // DDL namespace (platform only)
    'ddl.execute',
    'ddl.migrate',
    // Agent namespace (platform only)
    'agent.chat',
    // Workspace namespace (platform only)
    'workspace.sync',
  ],
  projectTools: [
    // Schema namespace (restricted)
    'schema.set',
    'schema.load',
    'schema.list',
    // Store namespace (full access to user schemas)
    'store.create',
    'store.get',
    'store.update',
    'store.delete',
    'store.query',
    // View namespace (execute/project only)
    'view.execute',
    'view.project',
  ],
}

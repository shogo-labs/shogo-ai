import { FastMCP } from "fastmcp"

// Schema tools
import { registerSchemaSet } from "./schema.set"
import { registerSchemaLoad } from "./schema.load"
import { registerSchemaList } from "./schema.list"

// Store tools
import { registerStoreCreate } from "./store.create"
import { registerStoreGet } from "./store.get"
import { registerStoreUpdate } from "./store.update"
import { registerStoreDelete } from "./store.delete"
import { registerStoreQuery } from "./store.query"

// View tools
import { registerViewExecute } from "./view.execute"
import { registerViewDefine } from "./view.define"
import { registerViewDelete } from "./view.delete"
import { registerViewProject } from "./view.project"

// DDL tools
import { registerDdlExecute } from "./ddl.execute"
import { registerDdlMigrate } from "./ddl.migrate"
import { registerDdlVerify } from "./ddl.verify"
import { registerDdlRecover } from "./ddl.recover"

// Agent tools
import { registerAgentChat } from "./agent.chat"

// Workspace tools
import { registerWorkspaceSync } from "./workspace.sync"

// SDK tools
import { registerSdkCreateRoutes } from "./sdk.create-routes"
import { registerSdkCreateApp } from "./sdk.create-app"

/**
 * Register Platform MCP tools on a FastMCP server instance.
 *
 * Platform MCP provides FULL access to all 18 Wavesmith tools for:
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
 * Total: 18 tools across 7 namespaces
 * - Schema: 3 tools (set, load, list)
 * - Store: 5 tools (create, get, update, delete, query)
 * - View: 4 tools (execute, define, delete, project)
 * - DDL: 4 tools (execute, migrate, verify, recover) - PLATFORM ONLY
 * - Agent: 1 tool (chat) - PLATFORM ONLY
 * - Workspace: 1 tool (sync) - PLATFORM ONLY
 * - SDK: 2 tools (createApp, createRoutes) - PLATFORM ONLY
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerPlatformTools(server: FastMCP) {
  // Schema namespace (3 tools)
  registerSchemaSet(server)
  registerSchemaLoad(server)
  registerSchemaList(server)

  // Store namespace (5 tools)
  registerStoreCreate(server)
  registerStoreGet(server)
  registerStoreUpdate(server)
  registerStoreDelete(server)
  registerStoreQuery(server)

  // View namespace (4 tools)
  registerViewExecute(server)
  registerViewDefine(server)
  registerViewDelete(server)
  registerViewProject(server)

  // DDL namespace (4 tools) - Platform only
  registerDdlExecute(server)
  registerDdlMigrate(server)
  registerDdlVerify(server)
  registerDdlRecover(server)

  // Agent namespace (1 tool) - Platform only
  registerAgentChat(server)

  // Workspace namespace (1 tool) - Platform only
  registerWorkspaceSync(server)

  // SDK namespace (2 tools) - Platform only
  registerSdkCreateRoutes(server)
  registerSdkCreateApp(server)
}

/**
 * Register Project MCP tools on a FastMCP server instance.
 *
 * Project MCP provides RESTRICTED access for user workspace operations:
 * - Schema management (read/write user schemas only)
 * - Store CRUD operations
 * - View execution
 *
 * Schema restrictions:
 * - Can ONLY access user workspace schemas
 * - NO access to: studio-core, platform-features, component-builder, studio-chat
 *
 * Available tools (10 of 16 total):
 * - Schema: 3 tools (set, load, list) - restricted to user workspace
 * - Store: 5 tools (create, get, update, delete, query)
 * - View: 2 tools (execute, project)
 *
 * Excluded tools:
 * - DDL: execute, migrate (platform-only - database schema changes are admin ops)
 * - Agent: chat (platform-only - AI orchestration is platform-level)
 * - Workspace: sync (platform-only - cross-workspace operations)
 * - View: define, delete (platform-only - view definitions are platform-managed)
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerProjectTools(server: FastMCP) {
  // Schema namespace (3 tools) - operations scoped to project workspace
  registerSchemaSet(server)
  registerSchemaLoad(server)
  registerSchemaList(server)

  // Store namespace (5 tools) - full CRUD for user data
  registerStoreCreate(server)
  registerStoreGet(server)
  registerStoreUpdate(server)
  registerStoreDelete(server)
  registerStoreQuery(server)

  // View namespace (2 tools) - execute and project only
  registerViewExecute(server)
  registerViewProject(server)

  // NOTE: The following are NOT registered for project context:
  // - registerViewDefine (platform-only)
  // - registerViewDelete (platform-only)
  // - registerDdlExecute (platform-only)
  // - registerDdlMigrate (platform-only)
  // - registerAgentChat (platform-only)
  // - registerWorkspaceSync (platform-only)
}

/**
 * Register all Wavesmith MCP tools on a FastMCP server instance.
 *
 * @deprecated Use registerPlatformTools() for platform context or
 * registerProjectTools() for project context. This function is kept
 * for backward compatibility and behaves identically to registerPlatformTools().
 *
 * Total: 16 tools across 6 namespaces
 * - Schema: 3 tools (set, load, list)
 * - Store: 5 tools (create, get, update, delete, query)
 * - View: 4 tools (execute, define, delete, project)
 * - DDL: 2 tools (execute, migrate)
 * - Agent: 1 tool (chat)
 * - Workspace: 1 tool (sync)
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerAllTools(server: FastMCP) {
  // Backward compatible - delegates to platform tools
  registerPlatformTools(server)
}

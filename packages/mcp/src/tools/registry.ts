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

// Data tools
import { registerDataBootstrap } from "./data.bootstrap"

// DDL tools
import { registerDdlExecute } from "./ddl.execute"
import { registerDdlMigrate } from "./ddl.migrate"

// Agent tools
import { registerAgentChat } from "./agent.chat"

/**
 * Register all Wavesmith MCP tools on a FastMCP server instance.
 * This is the single source of truth for tool registration.
 *
 * Total: 15 tools across 6 namespaces
 * - Schema: 3 tools (set, load, list)
 * - Store: 5 tools (create, get, update, delete, query)
 * - View: 4 tools (execute, define, delete, project)
 * - Data: 1 tool (bootstrap)
 * - DDL: 2 tools (execute, migrate)
 * - Agent: 1 tool (chat)
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerAllTools(server: FastMCP) {
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

  // Data namespace (1 tool)
  registerDataBootstrap(server)

  // DDL namespace (2 tools)
  registerDdlExecute(server)
  registerDdlMigrate(server)

  // Agent namespace (1 tool)
  registerAgentChat(server)
}

import { FastMCP } from "fastmcp"

// Schema tools
import { registerSchemaSet } from "./schema.set"
import { registerSchemaGet } from "./schema.get"
import { registerSchemaLoad } from "./schema.load"
import { registerSchemaList } from "./schema.list"

// Store tools
import { registerStoreModels } from "./store.models"
import { registerStoreCreate } from "./store.create"
import { registerStoreGet } from "./store.get"
import { registerStoreList } from "./store.list"
import { registerStoreUpdate } from "./store.update"
import { registerStoreDelete } from "./store.delete"
import { registerStoreQuery } from "./store.query"

// View tools
import { registerViewExecute } from "./view.execute"
import { registerViewDefine } from "./view.define"
import { registerViewDelete } from "./view.delete"
import { registerViewProject } from "./view.project"

// Data tools
import { registerDataLoad } from "./data.load"
import { registerDataLoadAll } from "./data.loadAll"

// DDL tools
import { registerDdlExecute } from "./ddl.execute"

// Agent tools
import { registerAgentChat } from "./agent.chat"

/**
 * Register all Wavesmith MCP tools on a FastMCP server instance.
 * This is the single source of truth for tool registration.
 *
 * Total: 19 tools across 6 namespaces
 * - Schema: 4 tools (set, get, load, list)
 * - Store: 7 tools (models, create, get, list, update, delete, query)
 * - View: 4 tools (execute, define, delete, project)
 * - Data: 2 tools (load, loadAll)
 * - DDL: 1 tool (execute)
 * - Agent: 1 tool (chat)
 *
 * @param server - FastMCP server instance (stdio or HTTP transport)
 */
export function registerAllTools(server: FastMCP) {
  // Schema namespace (4 tools)
  registerSchemaSet(server)
  registerSchemaGet(server)
  registerSchemaLoad(server)
  registerSchemaList(server)

  // Store namespace (7 tools)
  registerStoreModels(server)
  registerStoreCreate(server)
  registerStoreGet(server)
  registerStoreList(server)
  registerStoreUpdate(server)
  registerStoreDelete(server)
  registerStoreQuery(server)

  // View namespace (4 tools)
  registerViewExecute(server)
  registerViewDefine(server)
  registerViewDelete(server)
  registerViewProject(server)

  // Data namespace (2 tools)
  registerDataLoad(server)
  registerDataLoadAll(server)

  // DDL namespace (1 tool)
  registerDdlExecute(server)

  // Agent namespace (1 tool)
  registerAgentChat(server)
}

/**
 * MCPBackend
 *
 * Browser-side backend that creates MCPQueryExecutor instances.
 * Implements the createExecutor factory pattern for registry integration.
 *
 * This backend has no `dialect` property, which distinguishes it from SqlBackend.
 * The BackendRegistry checks for createExecutor() to route to this factory pattern.
 *
 * @remarks
 * Register as both 'mcp' and 'postgres' in BackendRegistry so schemas configured
 * with `x-persistence.backend: 'postgres'` work in the browser environment.
 */

import type { IBackend, BackendCapabilities, QueryResult, IQueryExecutor, Condition } from "@shogo/state-api"
import type { MCPService } from "../services/MCPService"
import { MCPQueryExecutor } from "./MCPQueryExecutor"

/**
 * MCP-backed backend for browser-side query execution.
 *
 * Uses createExecutor() factory pattern to create MCPQueryExecutor instances
 * that proxy to MCP tools for actual data operations.
 */
export class MCPBackend implements IBackend {
  /**
   * Capabilities supported by this backend.
   * Mirrors SQL backend capabilities since MCP tools support these operations.
   */
  readonly capabilities: BackendCapabilities = {
    operators: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "and", "or"],
    features: { sorting: true, pagination: true, relations: false },
  }

  constructor(
    private mcp: MCPService,
    private workspace?: string
  ) {}

  /**
   * Create an executor for the given schema/model.
   *
   * @param schemaName - Schema name
   * @param modelName - Model name within schema
   * @returns MCPQueryExecutor instance
   *
   * @remarks
   * This factory method is detected by BackendRegistry.resolve() which
   * calls it instead of creating MemoryQueryExecutor or SqlQueryExecutor.
   */
  createExecutor<T>(schemaName: string, modelName: string): IQueryExecutor<T> {
    return new MCPQueryExecutor<T>(this.mcp, schemaName, modelName, this.workspace)
  }

  /**
   * Direct execute() is not used - createExecutor() factory is the pattern.
   *
   * @throws Always throws directing to use createExecutor() instead
   */
  async execute<T>(condition: Condition, options?: any): Promise<QueryResult<T>> {
    throw new Error("Use createExecutor() instead")
  }
}

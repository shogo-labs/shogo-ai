/**
 * Domain Composition API Types
 *
 * The domain() function unifies ArkType scopes with enhancements and connects
 * to the meta-store system. Enhanced JSON Schema serves as the interchange format,
 * supporting bidirectional workflows (code-first and schema-first).
 */

import type { Scope } from "arktype"
import type { IAnyModelType, IAnyStateTreeNode } from "mobx-state-tree"
import type { EnhancedJsonSchema } from "../schematic/types"
import type { IEnvironment } from "../environment/types"

/**
 * Enhancement hooks for customizing MST models, collections, and root store.
 *
 * Each hook receives the generated models/collections and returns enhanced versions.
 * This allows adding computed views, actions, and domain-specific behavior.
 */
export interface DomainEnhancements {
  /**
   * Enhance individual entity models (add views, actions, etc.)
   * @param models - Record of model name → MST model type
   * @returns Enhanced models record
   */
  models?: (models: Record<string, IAnyModelType>) => Record<string, IAnyModelType>

  /**
   * Enhance collection models (add query methods, custom actions)
   * @param collections - Record of collection name → MST collection type
   * @returns Enhanced collections record
   */
  collections?: (collections: Record<string, IAnyModelType>) => Record<string, IAnyModelType>

  /**
   * Enhance the root store model (add domain-wide views/actions)
   * @param RootModel - The generated root store model type
   * @returns Enhanced root store model
   */
  rootStore?: (RootModel: IAnyModelType) => IAnyModelType
}

/**
 * Configuration for creating a domain.
 *
 * Supports two input modes:
 * - Code-first: `from` is an ArkType Scope (metadata merged from schema.json if exists)
 * - Schema-first: `from` is an Enhanced JSON Schema (metadata already embedded)
 */
export interface DomainConfig {
  /**
   * Schema name - used for registry lookup and schema.json path resolution
   */
  name: string

  /**
   * Input source: ArkType Scope or Enhanced JSON Schema
   *
   * When Scope: Converts to Enhanced JSON Schema, merges metadata from
   * `.schemas/{name}/schema.json` if exists.
   *
   * When EnhancedJsonSchema: Uses directly with embedded metadata.
   */
  from: Scope<any> | EnhancedJsonSchema

  /**
   * Enhancement hooks for models, collections, and root store.
   * Applied during MST model generation.
   */
  enhancements?: DomainEnhancements

  /**
   * Auto-compose CollectionPersistable on all collections.
   * @default true
   */
  persistence?: boolean

  /**
   * Auto-compose CollectionQueryable on all collections.
   * Enables .query() method for IQueryable builder pattern.
   * @default true
   */
  queryable?: boolean

  /**
   * Auto-compose CollectionAuthorizable on all collections.
   * Wraps query() with authorization filters based on x-authorization schema annotations.
   * Requires queryable to be enabled (no effect if queryable is false).
   * @default true
   */
  authorizable?: boolean

  /**
   * Auto-compose CollectionMutatable on all collections.
   * Enables insertOne, updateOne, deleteOne with backend writes.
   * @default true
   */
  mutatable?: boolean
}

/**
 * Result of domain() function.
 *
 * Provides two usage patterns:
 * - Direct: createStore(env) for standalone usage (tests, single-schema apps)
 * - Registered: register(metaStore) for multi-schema apps and MCP integration
 */
export interface DomainResult {
  /**
   * Schema name
   */
  name: string

  /**
   * The Enhanced JSON Schema (interchange format).
   * Always available regardless of input type.
   */
  enhancedSchema: EnhancedJsonSchema

  /**
   * The root store MST model type.
   * Use for typing or creating stores directly via RootStoreModel.create().
   */
  RootStoreModel: IAnyModelType

  /**
   * Entity model types keyed by name (e.g., { User: UserModel, Post: PostModel }).
   * Use for accessing individual entity types for custom composition or typing.
   */
  models: Record<string, IAnyModelType>

  /**
   * Direct store creation without meta-store.
   * Use for unit tests, standalone apps, or when meta-store isn't needed.
   *
   * @param env - Optional environment with services (persistence) and context
   * @returns MST store instance
   */
  createStore: (env?: IEnvironment) => IAnyStateTreeNode

  /**
   * Register with meta-store for multi-schema integration.
   * - Ingests schema into meta-store
   * - Caches enhancements in registry
   * - Creates and caches runtime store
   *
   * @param metaStore - The meta-store instance
   * @param options - Optional workspace path for isolation
   * @returns Schema entity from meta-store
   */
  register: (metaStore: any, options?: RegisterOptions) => any
}

/**
 * Options for registering a domain with meta-store
 */
export interface RegisterOptions {
  /**
   * Workspace path for data isolation.
   * Defaults to monorepo's .schemas directory.
   */
  workspace?: string
}

/**
 * Type guard to detect if input is an ArkType Scope.
 *
 * Scopes have an `export` method that returns resolved types.
 * This follows the pattern from arktype-to-json-schema.ts.
 */
export function isScope(value: unknown): value is Scope<any> {
  return (
    value !== null &&
    typeof value === "object" &&
    "export" in value &&
    typeof (value as any).export === "function"
  )
}

/**
 * Type guard to detect if input is an Enhanced JSON Schema.
 *
 * Enhanced JSON Schemas have standard JSON Schema structure with
 * $defs containing entity definitions and optional x-* extensions.
 */
export function isEnhancedJsonSchema(value: unknown): value is EnhancedJsonSchema {
  return (
    value !== null &&
    typeof value === "object" &&
    "$defs" in value &&
    typeof (value as any).$defs === "object"
  )
}

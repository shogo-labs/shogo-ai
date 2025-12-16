/**
 * Backend Abstraction Layer
 *
 * Provides pluggable query execution strategies with capability declaration
 * and schema-driven backend resolution.
 *
 * @module query/backends
 */

export type {
  IBackend,
  BackendCapabilities,
  QueryOptions,
  QueryResult,
  OrderByClause,
} from './types'

export { MemoryBackend } from './memory'
export { SqlBackend } from './sql'
export { PostgresBackend } from './postgres'
export { ContextAwareBackend } from './context-aware'

export type { IBackendRegistry, BackendRegistryConfig } from '../registry'
export { BackendRegistry, createBackendRegistry } from '../registry'

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

export type { IBackendRegistry, BackendRegistryConfig } from '../registry'
export { BackendRegistry, createBackendRegistry } from '../registry'

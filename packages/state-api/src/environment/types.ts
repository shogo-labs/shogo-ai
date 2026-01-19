/**
 * Environment type definitions for MST dependency injection.
 *
 * Defines the structure passed to createStore(env) for runtime stores.
 * Schema entities and persistence services are injected via this environment,
 * enabling pluggable backends and isomorphic state management patterns.
 *
 * Related:
 * - Unit 1: IPersistenceService interface (pluggable persistence abstraction)
 * - Unit 4: CollectionPersistable mixin (uses getEnv<IEnvironment>(self))
 *
 * @see persistence-service-rev2.md for architecture details
 */

import type { IPersistenceService } from '../persistence/types'
import type { IAuthService } from '../auth/types'
import type { IBillingService } from '../billing/types'
import type { IEmailService } from '../email/types'
import type { IRuntimeManager } from '../runtime/types'
import type { IBackendRegistry } from '../query/registry'
import type { IQueryValidator } from '../query/validation/types'
import type { ColumnPropertyMap, PropertyTypeMap } from '../query/execution/utils'
import type { ArrayReferenceMaps } from '../ddl/utils'

/**
 * Environment structure for runtime MST stores.
 *
 * This environment is passed as the second parameter to MST's .create() method:
 * ```typescript
 * const env: IEnvironment = {
 *   services: { persistence: new FileSystemPersistence() },
 *   context: { schema: schemaEntity, location: './workspace' }
 * }
 * const store = RootStoreModel.create({}, env)
 * ```
 *
 * Accessed in mixins via MST's getEnv() function:
 * ```typescript
 * .actions(self => ({
 *   async saveAll() {
 *     const env = getEnv<IEnvironment>(self)
 *     await env.services.persistence.saveCollection(...)
 *   }
 * }))
 * ```
 *
 * Design Notes:
 * - Nested structure: services (injected dependencies) + context (metadata)
 * - Required persistence service: all runtime stores need persistence
 * - Optional location: enables workspace isolation, defaults to '.schemas'
 * - Future extensibility: new interfaces can extend IEnvironment
 */
export interface IEnvironment {
  /**
   * Service dependencies injected at store creation.
   *
   * These are the "pluggable backends" - swap implementations without
   * changing MST model code.
   */
  services: {
    /**
     * Persistence service for loading/saving collection data.
     *
     * Implementation can be:
     * - FileSystemPersistence (local JSON files)
     * - NullPersistence (in-memory, for testing)
     * - SQLitePersistence (future: local database)
     * - PostgresPersistence (future: remote database)
     * - S3Persistence (future: cloud storage)
     *
     * Required - all runtime stores need persistence capability.
     */
    persistence: IPersistenceService

    /**
     * Authentication service for user auth flows.
     *
     * Implementation can be:
     * - SupabaseAuthService (real Supabase auth)
     * - MockAuthService (in-memory, for testing)
     *
     * Optional - not all stores need authentication.
     */
    auth?: IAuthService

    /**
     * Billing service for subscription and payment operations.
     *
     * Implementation can be:
     * - StripeBillingService (real Stripe integration)
     * - MockBillingService (in-memory, for testing)
     *
     * Optional - only needed for stores that handle billing operations.
     * Domain actions like consumeCredits, allocateMonthlyCredits can
     * access this service via getEnv(self).services.billing.
     *
     * @see IBillingService for interface details
     * @see StripeBillingService for production implementation
     */
    billing?: IBillingService

    /**
     * Email service for sending transactional emails.
     *
     * Implementation can be:
     * - SmtpEmailService (real SMTP integration via nodemailer)
     * - MockEmailService (in-memory, for testing)
     *
     * Optional - email is an enhancement, not a blocker.
     * If not configured, email-dependent features should gracefully
     * degrade (log warnings but don't throw errors).
     * Domain actions like sendInvitationEmail check for service
     * presence via getEnv(self).services.email?.isConfigured().
     *
     * @see IEmailService for interface details
     * @see SmtpEmailService for production implementation
     */
    email?: IEmailService

    /**
     * Backend registry for query execution.
     *
     * Maps backend names to IBackend implementations and resolves which backend
     * to use for a given schema/model using cascade lookup:
     * 1. Model's x-persistence.backend property
     * 2. Schema's x-persistence.backend property
     * 3. Registry default backend
     *
     * Implementation:
     * - BackendRegistry (standard implementation with Map-based storage)
     * - Created via createBackendRegistry({ default: 'memory', backends: {...} })
     *
     * Optional - only needed for queryable collections. Contexts like auth
     * or meta-store may not need query capabilities.
     *
     * @see IBackendRegistry for interface details
     * @see BackendRegistry for implementation
     * @see createBackendRegistry for factory function
     *
     * @example
     * ```typescript
     * const registry = createBackendRegistry({
     *   default: 'memory',
     *   backends: {
     *     memory: new MemoryBackend(),
     *     sql: new SqlBackend()
     *   }
     * })
     * const env: IEnvironment = {
     *   services: {
     *     persistence: new FileSystemPersistence(),
     *     backendRegistry: registry
     *   },
     *   context: { schemaName: 'my-schema' }
     * }
     * ```
     */
    backendRegistry?: IBackendRegistry

    /**
     * Query validator for schema-aware validation.
     *
     * Validates parsed query ASTs against schema/model definitions to ensure:
     * - Properties exist in the schema
     * - Operators are compatible with property types
     * - Actionable error messages for invalid queries
     *
     * Implementation:
     * - QueryValidator (standard implementation using meta-store)
     * - Uses lazy memoization for performance
     *
     * Optional - query validation can be skipped for performance or when
     * queries are generated programmatically and guaranteed to be valid.
     *
     * @see IQueryValidator for interface details
     * @see QueryValidator for implementation
     *
     * @example
     * ```typescript
     * const validator = new QueryValidator(metaStore)
     * const env: IEnvironment = {
     *   services: {
     *     persistence: new FileSystemPersistence(),
     *     backendRegistry: registry,
     *     queryValidator: validator  // Optional
     *   },
     *   context: { schemaName: 'my-schema' }
     * }
     * ```
     */
    queryValidator?: IQueryValidator

    /**
     * Runtime manager for project Vite dev server lifecycle.
     *
     * Responsible for:
     * - Spawning Vite dev server processes per project
     * - Port allocation and tracking
     * - Health monitoring
     * - Graceful shutdown
     *
     * Implementation can be:
     * - RuntimeManager (production - spawns real Vite processes)
     * - MockRuntimeManager (testing - simulates lifecycle)
     *
     * Optional - only needed for API routes that manage project runtimes.
     * Available when running in contexts that need to spawn/manage Vite servers.
     *
     * @see IRuntimeManager for interface details
     * @see RuntimeManager for production implementation
     * @see MockRuntimeManager for testing
     *
     * @example
     * ```typescript
     * const env: IEnvironment = {
     *   services: {
     *     persistence: new FileSystemPersistence(),
     *     runtime: new RuntimeManager({ basePort: 5200 })
     *   },
     *   context: { schemaName: 'studio-core' }
     * }
     * // In API route handler:
     * const runtime = await env.services.runtime?.start(projectId)
     * ```
     */
    runtime?: IRuntimeManager
  }

  /**
   * Contextual metadata about the runtime store.
   *
   * This is "where we are" - which schema, which workspace, etc.
   *
   * **Optional for meta-store:**
   * The meta-store itself doesn't belong to a schema - it manages schemas.
   * When creating the meta-store, context can be omitted.
   *
   * **Required for runtime stores:**
   * Runtime stores are tied to a specific schema and need context.schemaName.
   */
  context?: {
    /**
     * Schema name identifier (stable string reference).
     *
     * Instead of holding a live MST entity reference to the schema,
     * we store just the name (e.g., "minimal-cms", "app-builder-project").
     *
     * **Why schemaName instead of schema entity:**
     * 1. Prevents stale entity references during React StrictMode double-rendering
     * 2. Decouples runtime store lifecycle from meta-store entity lifecycle
     * 3. Schema entities can be detached/replaced without breaking runtime stores
     * 4. Simpler to reason about - just a string, no MST tree coupling
     *
     * The actual schema entity can be looked up from the meta-store when needed,
     * but for persistence context we only need the name.
     *
     * Required - every runtime store is tied to a schema definition.
     */
    schemaName: string

    /**
     * Optional location identifier for workspace isolation.
     *
     * Generic primitive that means different things to different backends:
     * - FileSystemPersistence: file path ("./workspace-a", "/absolute/path")
     * - PostgresPersistence: database name or schema prefix
     * - S3Persistence: bucket prefix ("s3://bucket/workspace-a")
     *
     * If not provided, persistence service should use sensible default:
     * - FileSystemPersistence uses ".schemas"
     * - NullPersistence uses "default"
     *
     * **Why generic "location" not "workspace":**
     * "Workspace" is app-builder vocabulary. This is low-level infrastructure
     * that should work for any use case (not just app-builder).
     */
    location?: string

    /**
     * Pre-computed column-to-property maps by model name.
     *
     * Injected by domain().createStore() to enable SQL backends to correctly
     * map snake_case column names back to camelCase property names.
     *
     * Optional - only needed for SQL backends via domain().createStore().
     */
    columnPropertyMaps?: Record<string, ColumnPropertyMap>

    /**
     * Pre-computed property type maps by model name.
     *
     * Injected by domain().createStore() to enable dialect-specific
     * type conversions (e.g., boolean to 0/1 for SQLite).
     *
     * Optional - only needed for SQL backends via domain().createStore().
     */
    propertyTypeMaps?: Record<string, PropertyTypeMap>

    /**
     * Pre-computed array reference metadata maps by model name.
     *
     * Injected by domain().createStore() to enable SqlQueryExecutor
     * to hydrate array references from junction tables.
     *
     * Optional - only needed for schemas with array references.
     */
    arrayReferenceMaps?: ArrayReferenceMaps
  }
}

/**
 * Type alias for schema entity (extracted from environment).
 *
 * This is a MST instance of the dynamically-generated Schema model from
 * the meta-store.
 *
 * At runtime, this will have properties like:
 * - id: string (UUID identifier)
 * - name: string (schema name, e.g., "app-builder-project")
 * - format: 'enhanced-json-schema' (always this value)
 * - createdAt: number (Unix timestamp)
 * - views: SchemaView[] (view definitions)
 * - toEnhancedJson(): EnhancedJsonSchema (conversion method)
 *
 * Typed as 'any' because the Schema model doesn't have a static export
 * (it's generated dynamically from ArkType definitions).
 *
 * Usage:
 * ```typescript
 * const schema: ISchemaEntity = env.context.schema
 * console.log(schema.name)  // TypeScript allows this (no IntelliSense though)
 * ```
 */
export type ISchemaEntity = any

/**
 * CollectionMutatable Mixin
 *
 * Adds mutation actions (insertOne, updateOne, deleteOne, etc.) to collections,
 * with backend-agnostic execution and MST state synchronization.
 *
 * @module composition/mutatable
 *
 * Requirements:
 * - REQ-MUT-01: Single entity mutations (insertOne, updateOne, deleteOne)
 * - REQ-MUT-02: Batch mutations (insertMany, updateMany, deleteMany)
 * - REQ-MUT-03: MST state sync after successful mutation
 * - REQ-MUT-04: Transaction support for batch operations
 * - Uses getEnv<IEnvironment>(self).services.backendRegistry
 *
 * Usage:
 * ```typescript
 * const MyCollection = types.compose(
 *   BaseCollection,
 *   CollectionMutatable
 * ).named('MyCollection')
 *
 * const collection = MyCollection.create({}, environment)
 *
 * // Single entity operations
 * const entity = await collection.insertOne({ name: 'Alice', status: 'active' })
 * await collection.updateOne(entity.id, { status: 'inactive' })
 * await collection.deleteOne(entity.id)
 *
 * // Batch operations
 * const entities = await collection.insertMany([...])
 * await collection.updateMany({ status: 'active' }, { status: 'archived' })
 * await collection.deleteMany({ status: 'archived' })
 * ```
 */

import { types, getEnv, applySnapshot, getSnapshot } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'
import type { QueryFilter } from '../query/ast/types'
import { parseQuery } from '../query/ast/parser'
import type { IQueryExecutor } from '../query/executors/types'
import { MemoryQueryExecutor } from '../query/executors/memory'

/**
 * Check if executor is remote (SQL backend) vs local (Memory backend).
 * Remote executors require MST sync after mutations.
 */
function isRemoteExecutor(executor: IQueryExecutor<any>): boolean {
  return executor.executorType === 'remote'
}

// ============================================================================
// CollectionMutatable Mixin
// ============================================================================

/**
 * Mutatable mixin for collections.
 * Provides mutation actions with backend execution and MST sync.
 *
 * @remarks
 * Requirements:
 * - Collection must have `modelName` view (from createCollectionModels)
 * - Collection must have `add()`, `get()`, `remove()` actions
 * - Environment must provide backendRegistry service
 */
export const CollectionMutatable = types
  .model('CollectionMutatable', {})
  .volatile(() => ({
    localExecutor: null as MemoryQueryExecutor<any> | null
  }))
  .actions((self) => {
    /**
     * Get the query executor for this collection.
     * Resolves via backendRegistry from environment.
     */
    function getExecutor<T>(): IQueryExecutor<T> {
      const env = getEnv<IEnvironment>(self)
      const registry = env.services.backendRegistry

      // Guard: backendRegistry is optional in IEnvironment but required for mutations
      if (!registry) {
        throw new Error(
          `backendRegistry is required for collection mutations. ` +
          `Add backendRegistry to your environment services when creating the store.`
        )
      }

      const schemaName = env.context?.schemaName ?? 'default'
      const modelName = (self as any).modelName ?? 'Unknown'

      // Get pre-computed maps from env.context (if available)
      // This enables createStore() to work with SQL backends without meta-store registration
      const columnPropertyMap = (env.context as any)?.columnPropertyMaps?.[modelName]
      const propertyTypes = (env.context as any)?.propertyTypeMaps?.[modelName]

      return registry.resolve<T>(schemaName, modelName, self, columnPropertyMap, propertyTypes)
    }

    return {
      /**
       * Initialize local executor for filtering MST entities during batch mutation sync.
       */
      afterCreate() {
        self.localExecutor = new MemoryQueryExecutor(self as any)
      },

      /**
       * Insert a new entity into the collection.
       *
       * @param data - Partial entity data (id will be generated if not provided)
       * @returns Promise resolving to the created entity
       */
      async insertOne<T>(data: Partial<T>): Promise<T> {
        const executor = getExecutor<T>()
        const result = await executor.insert(data)

        // Sync MST for remote executors (local already updates MST directly)
        if (isRemoteExecutor(executor)) {
          ;(self as any).add(result)
        }
        return result
      },

      /**
       * Update an existing entity in the collection.
       *
       * @param id - Entity identifier
       * @param changes - Partial entity data to merge
       * @returns Promise resolving to updated entity, or undefined if not found
       */
      async updateOne<T>(id: string, changes: Partial<T>): Promise<T | undefined> {
        const executor = getExecutor<T>()
        const result = await executor.update(id, changes)

        // Sync MST for remote executors (local already updates MST directly)
        if (result && isRemoteExecutor(executor)) {
          const instance = (self as any).get(id)
          if (instance) {
            // Apply the returned entity data to MST instance
            applySnapshot(instance, result)
          }
        }
        return result
      },

      /**
       * Delete an entity from the collection.
       *
       * @param id - Entity identifier
       * @returns Promise resolving to true if deleted, false if not found
       */
      async deleteOne(id: string): Promise<boolean> {
        const executor = getExecutor<any>()
        const success = await executor.delete(id)

        // Sync MST for remote executors (local already updates MST directly)
        if (success && isRemoteExecutor(executor)) {
          ;(self as any).remove(id)
        }
        return success
      },

      /**
       * Insert multiple entities in a single transaction.
       *
       * @param entities - Array of partial entity data
       * @returns Promise resolving to array of created entities
       */
      async insertMany<T>(entities: Partial<T>[]): Promise<T[]> {
        const executor = getExecutor<T>()
        const results = await executor.insertMany(entities)

        // Sync MST for remote executors (local already updates MST directly)
        if (isRemoteExecutor(executor)) {
          for (const entity of results) {
            ;(self as any).add(entity)
          }
        }
        return results
      },

      /**
       * Update multiple entities matching a filter.
       *
       * @param filter - MongoDB-style filter to match entities
       * @param changes - Partial entity data to apply to all matches
       * @returns Promise resolving to count of updated entities
       */
      async updateMany<T>(filter: QueryFilter, changes: Partial<T>): Promise<number> {
        const executor = getExecutor<T>()
        const ast = parseQuery(filter)
        const count = await executor.updateMany(ast, changes)

        // Sync MST for remote executors (local already updates MST directly)
        if (isRemoteExecutor(executor) && count > 0) {
          // Use local executor to filter matching MST entities (returns snapshots)
          const matchingSnapshots = await self.localExecutor!.select(ast)

          // Get MST instances by ID and update them
          for (const snapshot of matchingSnapshots) {
            const instance = (self as any).get((snapshot as any).id)
            if (instance) {
              const currentSnapshot = getSnapshot(instance) as Record<string, unknown>
              const updated = { ...currentSnapshot, ...changes }
              applySnapshot(instance, updated)
            }
          }
        }
        return count
      },

      /**
       * Delete multiple entities matching a filter.
       *
       * @param filter - MongoDB-style filter to match entities
       * @returns Promise resolving to count of deleted entities
       */
      async deleteMany(filter: QueryFilter): Promise<number> {
        const executor = getExecutor<any>()
        const ast = parseQuery(filter)
        const count = await executor.deleteMany(ast)

        // Sync MST for remote executors (local already updates MST directly)
        if (isRemoteExecutor(executor) && count > 0) {
          // Use local executor to filter matching MST entities (returns snapshots)
          const matchingSnapshots = await self.localExecutor!.select(ast)

          // Remove entities by ID
          for (const snapshot of matchingSnapshots) {
            ;(self as any).remove((snapshot as any).id)
          }
        }
        return count
      },
    }
  })

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

import { types, getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'
import type { QueryFilter } from '../query/ast/types'
import { parseQuery } from '../query/ast/parser'
import type { IQueryExecutor } from '../query/executors/types'

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
  .actions((self) => {
    /**
     * Get the query executor for this collection.
     * Resolves via backendRegistry from environment.
     */
    function getExecutor<T>(): IQueryExecutor<T> {
      const env = getEnv<IEnvironment>(self)
      const registry = env.services.backendRegistry
      const schemaName = env.context?.schemaName ?? 'default'
      const modelName = (self as any).modelName ?? 'Unknown'

      return registry.resolve<T>(schemaName, modelName, self)
    }

    return {
      /**
       * Insert a new entity into the collection.
       *
       * @param data - Partial entity data (id will be generated if not provided)
       * @returns Promise resolving to the created entity
       */
      async insertOne<T>(data: Partial<T>): Promise<T> {
        const executor = getExecutor<T>()
        return executor.insert(data)
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
        return executor.update(id, changes)
      },

      /**
       * Delete an entity from the collection.
       *
       * @param id - Entity identifier
       * @returns Promise resolving to true if deleted, false if not found
       */
      async deleteOne(id: string): Promise<boolean> {
        const executor = getExecutor<any>()
        return executor.delete(id)
      },

      /**
       * Insert multiple entities in a single transaction.
       *
       * @param entities - Array of partial entity data
       * @returns Promise resolving to array of created entities
       */
      async insertMany<T>(entities: Partial<T>[]): Promise<T[]> {
        const executor = getExecutor<T>()
        return executor.insertMany(entities)
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
        return executor.updateMany(ast, changes)
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
        return executor.deleteMany(ast)
      },
    }
  })

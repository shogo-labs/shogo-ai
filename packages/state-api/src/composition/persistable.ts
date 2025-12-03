import { types, getEnv, getSnapshot, applySnapshot } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'
import type { PersistenceContext } from '../persistence/types'

/**
 * Persistable mixin for collections.
 * Provides save/load operations using injected persistence service.
 *
 * Requirements:
 * - Collection must have `modelName` view (added by createCollectionModels in Unit 5)
 * - Collection must have `items` map property
 * - Environment must provide persistence service and schema context
 *
 * Usage:
 * ```typescript
 * const MyCollection = types.compose(
 *   BaseCollection,
 *   CollectionPersistable
 * ).named('MyCollection')
 *
 * const collection = MyCollection.create({}, environment)
 * await collection.loadAll()
 * await collection.saveAll()
 * ```
 */
export const CollectionPersistable = types.model()
  .views(self => ({
    /**
     * Derive persistence context from environment + collection's modelName view.
     * No string manipulation, no meta-store queries, just simple derivation.
     *
     * @returns PersistenceContext with schemaName, modelName, and optional location
     */
    get persistenceContext(): PersistenceContext {
      const env = getEnv<IEnvironment>(self)
      return {
        schemaName: env.context.schemaName,   // Stable string from environment
        modelName: (self as any).modelName,   // From collection's view (closure-based)
        location: env.context.location
      }
    }
  }))
  .actions(self => ({
    /**
     * Load all entities in this collection from persistence.
     * If no data exists, collection remains empty (no error thrown).
     *
     * @example
     * await collection.loadAll()
     */
    async loadAll() {
      const env = getEnv<IEnvironment>(self)
      const snapshot = await env.services.persistence.loadCollection(
        self.persistenceContext
      )
      if (snapshot) {
        applySnapshot(self, snapshot)
      }
    },

    /**
     * Load single entity by ID from persistence and add to collection.
     * If entity doesn't exist in persistence, returns undefined.
     * If entity exists, adds it to the collection and returns it.
     *
     * @param id - Entity identifier
     * @returns The loaded entity instance, or undefined if not found
     *
     * @example
     * const task = await collection.loadById('task-123')
     * if (task) {
     *   console.log(task.title)
     * }
     */
    async loadById(id: string) {
      const env = getEnv<IEnvironment>(self)
      const entitySnapshot = await env.services.persistence.loadEntity({
        ...self.persistenceContext,
        entityId: id
      })
      if (entitySnapshot) {
        // Use collection's add action (requires collection to have add() action)
        (self as any).add(entitySnapshot)
      }
      return (self as any).get(id)
    },

    /**
     * Save entire collection to persistence.
     * Serializes all entities in the collection using MST snapshots.
     *
     * @example
     * collection.add({ id: '1', title: 'Task' })
     * await collection.saveAll()
     */
    async saveAll() {
      const env = getEnv<IEnvironment>(self)
      await env.services.persistence.saveCollection(
        self.persistenceContext,
        getSnapshot(self)
      )
    },

    /**
     * Save single entity by ID to persistence.
     * Throws error if entity is not found in the collection.
     *
     * @param id - Entity identifier
     * @throws Error if entity with given id doesn't exist in collection
     *
     * @example
     * collection.add({ id: '1', title: 'Task' })
     * await collection.saveOne('1')
     */
    async saveOne(id: string) {
      const entity = (self as any).items.get(id)
      if (!entity) {
        throw new Error(`Entity ${id} not found in collection`)
      }
      const env = getEnv<IEnvironment>(self)
      await env.services.persistence.saveEntity({
        ...self.persistenceContext,
        entityId: id
      }, getSnapshot(entity))
    }
  }))

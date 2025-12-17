/**
 * MST composition mixins for runtime collections.
 *
 * Mixins add cross-cutting concerns (persistence, queries, validation, audit, sync)
 * to dynamically-generated collections without modifying core model definitions.
 *
 * Pattern:
 * ```typescript
 * const EnhancedCollection = types.compose(
 *   BaseCollection,
 *   CollectionPersistable,
 *   CollectionQueryable
 * ).named('TaskCollection')
 * ```
 *
 * Available Mixins:
 * - CollectionPersistable - adds loadAll/saveAll/loadById/saveOne actions
 * - CollectionQueryable - adds .query() method for LINQ-style queries
 *
 * Future Mixins:
 * - CollectionValidatable - ArkType validation before persistence
 * - CollectionTimestamped - automatic createdAt/updatedAt tracking
 * - CollectionAuditable - change history tracking
 * - CollectionSyncable - real-time sync via WebSocket/Supabase
 */

// Persistence mixin
export { CollectionPersistable } from './persistable'

// Queryable mixin
export { CollectionQueryable, type IQueryable } from './queryable'

// Mutatable mixin
export { CollectionMutatable } from './mutatable'

// Shared utility for collection enhancement (used by domain() and loadSchema())
export { buildEnhanceCollections } from './enhance-collections'

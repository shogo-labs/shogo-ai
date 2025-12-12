/**
 * MST composition mixins for runtime collections.
 *
 * Mixins add cross-cutting concerns (persistence, validation, audit, sync)
 * to dynamically-generated collections without modifying core model definitions.
 *
 * Pattern:
 * ```typescript
 * const EnhancedCollection = types.compose(
 *   BaseCollection,
 *   CollectionPersistable
 * ).named('TaskCollection')
 * ```
 *
 * Available Mixins:
 * - (Unit 4) CollectionPersistable - adds loadAll/saveAll/loadById/saveOne actions
 *
 * Future Mixins:
 * - CollectionValidatable - ArkType validation before persistence
 * - CollectionTimestamped - automatic createdAt/updatedAt tracking
 * - CollectionAuditable - change history tracking
 * - CollectionSyncable - real-time sync via WebSocket/Supabase
 */

// Unit 4: Persistable mixin
export { CollectionPersistable } from './persistable'

// Shared utility for collection enhancement (used by domain() and loadSchema())
export { buildEnhanceCollections } from './enhance-collections'

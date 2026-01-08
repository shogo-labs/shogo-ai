/**
 * Studio Core Domain Barrel Exports
 *
 * Re-exports all public APIs from the studio-core domain including:
 * - StudioCoreDomain (ArkType scope)
 * - studioCoreDomain (domain result)
 * - RoleLevels constant
 * - Types and store factory
 * - Seed IDs for deterministic operations
 */

export {
  StudioCoreDomain,
  studioCoreDomain,
  RoleLevels,
  createStudioCoreStore,
  type CreateStudioCoreStoreOptions,
} from './domain'

// Seed IDs for deterministic seed operations
export {
  SHOGO_ORG_ID,
  PLATFORM_PROJECT_ID,
  SHOGO_DEFAULT_TEAM_ID,
} from './seeds/ids'

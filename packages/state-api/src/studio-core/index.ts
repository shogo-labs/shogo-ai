/**
 * Studio Core Domain Barrel Exports
 *
 * Re-exports all public APIs from the studio-core domain including:
 * - StudioCoreDomain (ArkType scope)
 * - studioCoreDomain (domain result)
 * - RoleLevels constant
 * - Types and store factory
 * - Bootstrap utilities
 */

export {
  StudioCoreDomain,
  studioCoreDomain,
  RoleLevels,
  createStudioCoreStore,
  type CreateStudioCoreStoreOptions,
} from './domain'

export {
  bootstrapStudioCore,
  getBootstrapData,
  type BootstrapData,
  type BootstrapResult,
} from './bootstrap'

// Seed IDs for deterministic bootstrap operations
export {
  SHOGO_ORG_ID,
  PLATFORM_PROJECT_ID,
  SHOGO_DEFAULT_TEAM_ID,
} from './seeds/ids'

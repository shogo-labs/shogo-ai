/**
 * StudioCore - Domain store for workspace, project, member management
 */

export {
  studioCoreDomain,
  createStudioCoreStore,
  RoleLevels,
} from "./domain"

// Re-export generated schema for tests that need to access the scope
export { StudioCoreScope } from "../generated/studio-core.schema"
// Alias for backwards compatibility with tests
export { StudioCoreScope as StudioCoreDomain } from "../generated/studio-core.schema"

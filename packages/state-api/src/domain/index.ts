/**
 * Domain Composition API
 *
 * The domain() function unifies ArkType scopes with enhancements and connects
 * to the meta-store system. Enhanced JSON Schema is the interchange format,
 * supporting bidirectional workflows (code-first and schema-first).
 *
 * @example
 * ```typescript
 * import { domain } from "@shogo/state-api"
 *
 * const teams = domain({
 *   name: "teams-workspace",
 *   from: TeamsDomain,  // ArkType Scope
 *   enhancements: {
 *     models: (models) => ({
 *       Membership: models.Membership.views(self => ({
 *         get level() { return RoleLevels[self.role] }
 *       }))
 *     }),
 *     collections: (cols) => ({ ... }),
 *     rootStore: (Root) => Root.views(self => ({ ... }))
 *   }
 * })
 *
 * // Direct usage (tests, standalone)
 * const store = teams.createStore(env)
 *
 * // Or register with meta-store (multi-schema apps, MCP)
 * const schema = teams.register(metaStore)
 * ```
 */

export type {
  DomainConfig,
  DomainEnhancements,
  DomainResult,
  RegisterOptions,
} from "./types"

export { isScope, isEnhancedJsonSchema } from "./types"

export {
  registerEnhancements,
  getEnhancements,
  hasEnhancements,
  clearEnhancementRegistry,
  removeEnhancements,
} from "./enhancement-registry"

export { mergeMetadataFromFile } from "./metadata-merge"
export type { SchemaLoader } from "./metadata-merge"

// Export the domain() function from domain.ts
export { domain } from "./domain"

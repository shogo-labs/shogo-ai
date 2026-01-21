/**
 * Authorization Config Extraction (v2)
 *
 * Extracts `x-authorization` annotations from schema definitions.
 * Supports three patterns: direct scope, cascade scope, and self-scoping.
 *
 * Follows the pattern established by `extractPersistenceConfig()` in persistence/helpers.ts
 */

import type { AuthorizationConfig } from './types'

/**
 * Extract authorization configuration from a model definition (v2).
 *
 * Reads the `x-authorization` extension from a schema model definition
 * and returns a normalized AuthorizationConfig object.
 *
 * Supports three authorization patterns:
 * 1. Direct scope: { scope, scopeField }
 * 2. Cascade scope: { scope, scopeField, cascadeFrom }
 * 3. Self-scoping: { selfScoping }
 *
 * @param modelDef - The model definition object from schema.$defs[ModelName]
 * @returns AuthorizationConfig or null if no authorization configured
 *
 * @example Direct scope
 * const config = extractAuthorizationConfig({
 *   'x-authorization': { scope: 'workspace', scopeField: 'id' }
 * })
 * // Returns: { scope: 'workspace', scopeField: 'id' }
 *
 * @example Cascade scope
 * const config = extractAuthorizationConfig({
 *   'x-authorization': {
 *     scope: 'project',
 *     scopeField: 'id',
 *     cascadeFrom: { scope: 'workspace', foreignKey: 'workspace' }
 *   }
 * })
 * // Returns: { scope: 'project', scopeField: 'id', cascadeFrom: { scope: 'workspace', foreignKey: 'workspace' } }
 *
 * @example Self-scoping
 * const config = extractAuthorizationConfig({
 *   'x-authorization': { selfScoping: { field: 'userId' } }
 * })
 * // Returns: { selfScoping: { field: 'userId' } }
 */
export function extractAuthorizationConfig(modelDef: any): AuthorizationConfig | null {
  // Handle null/undefined input
  if (!modelDef) {
    return null
  }

  const xAuthorization = modelDef['x-authorization']

  // No x-authorization extension - no auth config
  if (!xAuthorization) {
    return null
  }

  // Check for self-scoping pattern first
  if (xAuthorization.selfScoping) {
    const field = xAuthorization.selfScoping.field
    if (!field || typeof field !== 'string') {
      return null  // Invalid selfScoping config
    }
    return {
      selfScoping: { field }
    }
  }

  // Scope-based patterns require scope and scopeField
  const scope = xAuthorization.scope
  if (!scope || typeof scope !== 'string') {
    return null
  }

  const scopeField = xAuthorization.scopeField
  if (!scopeField || typeof scopeField !== 'string') {
    return null
  }

  const config: AuthorizationConfig = {
    scope,
    scopeField
  }

  // Check for cascade pattern
  if (xAuthorization.cascadeFrom) {
    const cascadeScope = xAuthorization.cascadeFrom.scope
    const cascadeForeignKey = xAuthorization.cascadeFrom.foreignKey

    if (cascadeScope && typeof cascadeScope === 'string' &&
        cascadeForeignKey && typeof cascadeForeignKey === 'string') {
      config.cascadeFrom = {
        scope: cascadeScope,
        foreignKey: cascadeForeignKey
      }
    }
    // If cascadeFrom is present but invalid, we still return the base config
    // This allows for graceful degradation
  }

  return config
}

/**
 * Extract authorization configs for all models in a schema's $defs.
 *
 * Iterates through all model definitions and extracts authorization
 * configuration where present. Models without `x-authorization` are
 * not included in the result.
 *
 * @param defs - Schema $defs object (Record<ModelName, ModelDefinition>)
 * @returns Map of model name to AuthorizationConfig (only models with config)
 *
 * @example
 * const configs = extractAllAuthorizationConfigs({
 *   Project: { 'x-authorization': { scope: 'workspace', scopeField: 'workspaceId' } },
 *   Task: { 'x-authorization': { scope: 'project', scopeField: 'projectId' } },
 *   Tag: { type: 'object' }  // No authorization
 * })
 * // configs.size === 2
 * // configs.get('Project') === { scope: 'workspace', scopeField: 'workspaceId' }
 * // configs.get('Task') === { scope: 'project', scopeField: 'projectId' }
 * // configs.has('Tag') === false
 */
export function extractAllAuthorizationConfigs(
  defs: Record<string, any>
): Map<string, AuthorizationConfig> {
  const configs = new Map<string, AuthorizationConfig>()

  if (!defs || typeof defs !== 'object') {
    return configs
  }

  for (const [modelName, modelDef] of Object.entries(defs)) {
    const config = extractAuthorizationConfig(modelDef)
    if (config) {
      configs.set(modelName, config)
    }
  }

  return configs
}

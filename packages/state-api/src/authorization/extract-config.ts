/**
 * Authorization Config Extraction
 *
 * Extracts `x-authorization` annotations from schema definitions.
 * Follows the pattern established by `extractPersistenceConfig()` in persistence/helpers.ts
 */

import type { AuthorizationConfig } from './types'

/**
 * Extract authorization configuration from a model definition.
 *
 * Reads the `x-authorization` extension from a schema model definition
 * and returns a normalized AuthorizationConfig object.
 *
 * @param modelDef - The model definition object from schema.$defs[ModelName]
 * @returns AuthorizationConfig or null if no authorization configured
 *
 * @example
 * const config = extractAuthorizationConfig({
 *   type: 'object',
 *   'x-authorization': { scope: 'project', scopeField: 'projectId' },
 *   properties: { ... }
 * })
 * // Returns: { scope: 'project', scopeField: 'projectId' }
 *
 * @example
 * // Model without x-authorization
 * const config = extractAuthorizationConfig({ type: 'object', properties: {} })
 * // Returns: null
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

  // Extract and validate scope - must be a non-empty string
  // NOTE: We do NOT validate against an enum - scope is domain-agnostic
  const scope = xAuthorization.scope
  if (!scope || typeof scope !== 'string') {
    return null
  }

  // Extract and validate scopeField - must be a non-empty string
  const scopeField = xAuthorization.scopeField
  if (!scopeField || typeof scopeField !== 'string') {
    return null
  }

  return {
    scope,
    scopeField
  }
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

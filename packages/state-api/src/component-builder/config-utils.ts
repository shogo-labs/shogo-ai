/**
 * Config Cascade Utilities
 *
 * Utilities for merging XRendererConfig from multiple sources
 * in the correct priority order.
 */

import type { XRendererConfig } from "./types"

/**
 * Merges XRendererConfig from multiple sources in priority order.
 *
 * Priority (lowest to highest):
 * 1. componentDefaults - Baked into the component implementation
 * 2. bindingConfig - From RendererBinding.defaultConfig
 * 3. schemaConfig - From PropertyMetadata.xRendererConfig
 * 4. callerConfig - From PropertyRenderer config prop (highest priority)
 *
 * Later values override earlier values for the same key.
 * customProps are deep-merged (later values override per-key).
 *
 * @example
 * ```typescript
 * const config = mergeRendererConfig(
 *   { size: "md", truncate: 200 },     // component defaults
 *   { size: "lg" },                     // binding config
 *   { variant: "emphasized" },          // schema config
 *   { customProps: { onClick: fn } }    // caller config (optional)
 * )
 * // Result: { size: "lg", truncate: 200, variant: "emphasized", customProps: { onClick: fn } }
 * ```
 */
export function mergeRendererConfig(
  componentDefaults?: XRendererConfig,
  bindingConfig?: XRendererConfig,
  schemaConfig?: XRendererConfig,
  callerConfig?: XRendererConfig
): XRendererConfig {
  const result: XRendererConfig = {}

  // Apply in order: component defaults < binding < schema < caller
  const configs = [componentDefaults, bindingConfig, schemaConfig, callerConfig]

  for (const config of configs) {
    if (!config) continue

    // Shallow merge for standard properties
    if (config.variant !== undefined) result.variant = config.variant
    if (config.size !== undefined) result.size = config.size
    if (config.layout !== undefined) result.layout = config.layout
    if (config.truncate !== undefined) result.truncate = config.truncate
    if (config.expandable !== undefined) result.expandable = config.expandable
    if (config.clickable !== undefined) result.clickable = config.clickable

    // Deep merge for customProps
    if (config.customProps) {
      result.customProps = { ...result.customProps, ...config.customProps }
    }
  }

  return result
}

/**
 * PropertyRenderer - Universal property display component
 *
 * Takes PropertyMetadata and a value, resolves the appropriate display
 * component via ComponentRegistry, and renders it.
 *
 * Config cascade (highest to lowest priority):
 * 1. Caller-provided config (prop) - enables interactive behavior via customProps
 * 2. Schema-level xRendererConfig on PropertyMetadata
 * 3. Binding-level defaultConfig on matched ComponentEntry
 *
 * The config prop enables passing interactive behavior (onClick, disabled, etc.)
 * through customProps, proving that renderers are NOT "display only".
 *
 * Wrapped with observer() for MST reactivity when values come from
 * observable stores.
 *
 * Task: task-component-registry, task-cbe-008
 */

import { observer } from "mobx-react-lite"
import { mergeRendererConfig, type XRendererConfig } from "@shogo/state-api"
import { useComponentRegistry } from "./ComponentRegistryContext"
import type { PropertyMetadata, DisplayRendererProps } from "./types"

export interface PropertyRendererProps {
  /** Property metadata for resolution */
  property: PropertyMetadata
  /** Value to render */
  value: any
  /** Optional resolved entity for reference displays */
  entity?: any
  /** Current nesting depth for recursive rendering (default 0) */
  depth?: number
  /** Optional config override (highest priority in cascade) */
  config?: XRendererConfig
}

/**
 * PropertyRenderer component - resolves and renders the appropriate display
 */
export const PropertyRenderer = observer(function PropertyRenderer({
  property,
  value,
  entity,
  depth = 0,
  config: callerConfig
}: PropertyRendererProps) {
  const registry = useComponentRegistry()
  const Component = registry.resolve(property)
  const entry = registry.getEntry(property)

  // Merge config cascade: binding defaults < schema config < caller config
  // Caller config has highest priority (enables interactive props via customProps)
  const config = mergeRendererConfig(
    entry?.defaultConfig,
    property.xRendererConfig,
    callerConfig
  )

  const props: DisplayRendererProps = {
    property,
    value,
    entity,
    depth,
    config
  }

  return <Component {...props} />
})

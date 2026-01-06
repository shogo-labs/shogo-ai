/**
 * PropertyRenderer - Universal property display component
 *
 * Takes PropertyMetadata and a value, resolves the appropriate display
 * component via ComponentRegistry, and renders it.
 *
 * Wrapped with observer() for MST reactivity when values come from
 * observable stores.
 *
 * Task: task-component-registry
 */

import { observer } from "mobx-react-lite"
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
}

/**
 * PropertyRenderer component - resolves and renders the appropriate display
 */
export const PropertyRenderer = observer(function PropertyRenderer({
  property,
  value,
  entity,
  depth = 0
}: PropertyRendererProps) {
  const registry = useComponentRegistry()
  const Component = registry.resolve(property)

  const props: DisplayRendererProps = {
    property,
    value,
    entity,
    depth
  }

  return <Component {...props} />
})

/**
 * PropertyFieldSection - Section wrapper for PropertyRenderer
 * Task: task-cb-ui-definition-panel
 *
 * Bridges the Section rendering pipeline (used by SlotLayout/ComposablePhaseView)
 * to the PropertyRenderer pipeline (used for field-level display).
 *
 * This section is used by ComponentBuilder to render property fields in the preview.
 * It receives property metadata via config and delegates to PropertyRenderer for
 * actual rendering, leveraging the existing RendererBinding resolution system.
 *
 * Config structure:
 * - property: string - The property name
 * - propertyMeta: PropertyMetadata - Full property metadata for resolution
 * - value?: any - Optional value to display (for sample data)
 * - rendererConfig?: XRendererConfig - Optional config overrides
 */

import { observer } from "mobx-react-lite"
import type { SectionRendererProps } from "../types"
import { PropertyRenderer } from "../PropertyRenderer"
import type { PropertyMetadata } from "../types"

/**
 * PropertyFieldSection - Renders a single property field using the PropertyRenderer pipeline
 *
 * Used by ComponentBuilder preview to render selected properties. Wraps PropertyRenderer
 * so it can be used within the Section/SlotLayout architecture.
 */
export const PropertyFieldSection = observer(function PropertyFieldSection({
  feature,
  config,
}: SectionRendererProps) {
  const propertyMeta = config?.propertyMeta as PropertyMetadata | undefined
  const propertyName = config?.property as string | undefined
  const value = config?.value
  const rendererConfig = config?.rendererConfig

  // If no property metadata, show placeholder
  if (!propertyMeta) {
    return (
      <div className="p-3 border border-dashed border-muted rounded-md">
        <span className="text-sm text-muted-foreground">
          {propertyName ? `Property: ${propertyName}` : "No property configured"}
        </span>
      </div>
    )
  }

  return (
    <div className="py-2 px-3 border-b border-border last:border-b-0">
      <div className="flex items-center gap-3">
        {/* Property label */}
        <span className="text-xs font-medium text-muted-foreground min-w-[100px]">
          {propertyMeta.name}
        </span>
        {/* Property value via PropertyRenderer */}
        <div className="flex-1">
          <PropertyRenderer
            property={propertyMeta}
            value={value}
            config={rendererConfig}
          />
        </div>
      </div>
    </div>
  )
})

export default PropertyFieldSection

/**
 * DynamicCompositionSection - Render any Composition entity by ID
 * Task: task-cb-ui-dynamic-composition-section, task-cb-ui-hot-registration
 *
 * This enables hot registration: user-created components are immediately
 * usable without code deployment. Claude can reference saved compositions
 * by name via set_workspace.
 *
 * Data Flow:
 * 1. useDomains() -> componentBuilder store
 * 2. compositionCollection.get(compositionId) -> Composition entity
 * 3. composition.toSlotSpecs() -> SlotSpec[] (slotName, sectionRef, config)
 * 4. DynamicSectionRenderer(sectionRef) -> React Component (with hot registration)
 * 5. <SlotLayout layout={template}>{slotChildren}</SlotLayout>
 *
 * @example
 * ```tsx
 * // In composition slotContent:
 * { slot: "main", component: "DynamicCompositionSection", config: {
 *   compositionId: "comp-user-dashboard-001"
 * }}
 * ```
 */

import { observer } from "mobx-react-lite"
import type { ReactNode } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { SlotLayout } from "../composition/SlotLayout"
import { DynamicSectionRenderer } from "../sectionImplementations"
import type { SectionRendererProps } from "../types"
import type { SlotSpec } from "@shogo/state-api"

// =============================================================================
// Configuration Interface
// =============================================================================

/**
 * Configuration options for DynamicCompositionSection
 *
 * These options can be set via slotContent.config in composition entities
 * and modified at runtime via MCP store.update commands.
 */
export interface DynamicCompositionConfig {
  /**
   * ID of the Composition entity to render.
   * Required - if not provided or not found, shows an error state.
   */
  compositionId: string
}

// =============================================================================
// Main Section Component
// =============================================================================

/**
 * DynamicCompositionSection - Dynamically render any Composition by ID
 * Task: task-cb-ui-dynamic-composition-section
 *
 * Key to hot registration: This section renders ANY Composition entity by ID,
 * enabling user-created components to be immediately usable without code
 * deployment.
 *
 * Features:
 * - Retrieves Composition from componentBuilder.compositionCollection
 * - Uses toSlotSpecs() to get slot specifications
 * - Resolves sectionRef via DynamicSectionRenderer (with hot registration)
 * - Renders slots via SlotLayout with the Composition's layout template
 * - MobX observer wrapping for reactivity
 *
 * @param feature - The current FeatureSession data (passed through to child sections)
 * @param config - Must include compositionId
 */
export const DynamicCompositionSection = observer(
  function DynamicCompositionSection({ feature, config }: SectionRendererProps) {
    const dynamicConfig = config as unknown as DynamicCompositionConfig | undefined

    // 1. Access componentBuilder domain from DomainProvider
    const domains = useDomains()
    const componentBuilder = domains?.componentBuilder

    // 2. Get composition by ID
    const composition = componentBuilder?.compositionCollection?.get(
      dynamicConfig?.compositionId
    )

    // Handle missing composition
    if (!composition) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <div>Composition not found</div>
            <div className="text-sm mt-1">
              ID: {dynamicConfig?.compositionId ?? "none"}
            </div>
          </div>
        </div>
      )
    }

    // 3. Get layout template from composition
    // composition.layout can be an MST reference (object) or string ID
    const layoutRef = composition.layout
    const layoutId = typeof layoutRef === "string" ? layoutRef : layoutRef?.id
    const layoutTemplate =
      componentBuilder?.layoutTemplateCollection?.get?.(layoutId) ?? layoutRef

    if (!layoutTemplate || !layoutTemplate.slots) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <div>No layout template found</div>
            <div className="text-sm mt-1">
              Composition: {composition.name ?? dynamicConfig?.compositionId}
            </div>
          </div>
        </div>
      )
    }

    // 4. Get slot specs from composition
    const slotSpecs: SlotSpec[] = composition.toSlotSpecs?.() ?? []

    // Handle empty composition
    if (slotSpecs.length === 0) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          Empty composition
        </div>
      )
    }

    // 5. Resolve each sectionRef to a React component and build slot children
    // Group by slot name to support slot stacking (multiple sections in same slot)
    // Uses DynamicSectionRenderer for hot registration support (task-cb-ui-hot-registration)
    const slotChildren: Record<string, ReactNode | ReactNode[]> = {}
    for (const spec of slotSpecs) {
      const element = (
        <DynamicSectionRenderer
          key={spec.sectionRef}
          sectionName={spec.sectionRef}
          feature={feature}
          config={spec.config}
        />
      )

      // If slot already has content, convert to array or push to existing array
      if (slotChildren[spec.slotName] !== undefined) {
        const existing = slotChildren[spec.slotName]
        if (Array.isArray(existing)) {
          existing.push(element)
        } else {
          slotChildren[spec.slotName] = [existing as ReactNode, element]
        }
      } else {
        slotChildren[spec.slotName] = element
      }
    }

    // 6. Render via SlotLayout
    return (
      <SlotLayout layout={layoutTemplate} className="h-full">
        {slotChildren}
      </SlotLayout>
    )
  }
)

export default DynamicCompositionSection

/**
 * ComposablePhaseView Component
 * Task: task-cpv-012, task-cb-ui-hot-registration
 *
 * Main renderer component that composes phase views from data-driven
 * section components. Looks up Composition by phase name, resolves
 * slotContent to section components via sectionImplementationMap,
 * and renders sections in SlotLayout.
 *
 * Data Flow:
 * 1. useDomains() -> componentBuilder store
 * 2. compositionCollection.findByName(phaseName) -> Composition entity
 * 3. composition.layout -> LayoutTemplate reference
 * 4. composition.toSlotSpecs() -> SlotSpec[] (slotName, sectionRef, config)
 * 5. DynamicSectionRenderer(sectionRef) -> React Component (with hot registration support)
 * 6. <SlotLayout layout={template}>{slotChildren}</SlotLayout>
 *
 * @example
 * ```tsx
 * <ComposablePhaseView
 *   phaseName="discovery"
 *   feature={featureSession}
 * />
 * ```
 */

import { observer } from "mobx-react-lite"
import type { ReactNode } from "react"
import { useDomains } from "@shogo/app-core"
import { SlotLayout } from "./SlotLayout"
import { DynamicSectionRenderer } from "../sectionImplementations"
import { getProviderComponent } from "./providerImplementationMap"
import type { SlotSpec } from "@shogo/state-api"

/**
 * Props for ComposablePhaseView
 */
export interface ComposablePhaseViewProps {
  /**
   * Phase name to look up Composition.
   * Matches Composition.name in component-builder domain.
   * Examples: "discovery", "analysis", "design", "spec", "testing", "implementation"
   */
  phaseName: string

  /**
   * The current feature session data.
   * Passed to each resolved section component.
   * Typed as 'any' to match codebase patterns for MST instance types.
   */
  feature: any

  /**
   * Optional additional CSS classes for the root container
   */
  className?: string
}

/**
 * ComposablePhaseView - Data-driven phase view composition
 *
 * Resolves Composition entity by phase name and renders its slotContent
 * as section components within a SlotLayout.
 *
 * Wrapped with MobX observer() for reactivity to Composition changes
 * in the componentBuilder store.
 */
export const ComposablePhaseView = observer(function ComposablePhaseView({
  phaseName,
  feature,
  className,
}: ComposablePhaseViewProps) {
  // 1. Access componentBuilder domain from DomainProvider
  const domains = useDomains()
  const componentBuilder = domains?.componentBuilder

  // 2. Find composition by phase name
  const composition = componentBuilder?.compositionCollection?.findByName?.(phaseName)

  if (!composition) {
    return (
      <div className="p-4 text-muted-foreground">
        No composition found for phase: {phaseName}
      </div>
    )
  }

  // 3. Get layout template from composition
  // composition.layout can be an MST reference (object) or string ID
  const layoutRef = composition.layout
  const layoutId = typeof layoutRef === "string" ? layoutRef : layoutRef?.id
  const layoutTemplate = componentBuilder?.layoutTemplateCollection?.get?.(layoutId) ?? layoutRef

  if (!layoutTemplate || !layoutTemplate.slots) {
    return (
      <div className="p-4 text-muted-foreground">
        No layout template found for composition: {composition.name}
      </div>
    )
  }

  // 4. Get slot specs from composition
  const slotSpecs: SlotSpec[] = composition.toSlotSpecs?.() ?? []

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

  // 6. Build the SlotLayout content
  const slotLayoutContent = (
    <SlotLayout layout={layoutTemplate} className={className}>
      {slotChildren}
    </SlotLayout>
  )

  // 7. Optionally wrap with provider if composition specifies providerWrapper
  const providerWrapper = composition.providerWrapper
  if (providerWrapper) {
    const ProviderComponent = getProviderComponent(providerWrapper)
    if (ProviderComponent) {
      return (
        <ProviderComponent
          feature={feature}
          config={composition.providerConfig}
        >
          {slotLayoutContent}
        </ProviderComponent>
      )
    }
  }

  // 8. Return SlotLayout directly if no provider wrapper
  return slotLayoutContent
})

export default ComposablePhaseView

/**
 * ComposablePhaseView Component
 * Task: task-cpv-012
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
 * 5. getSectionComponent(sectionRef) -> React Component
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
import { useDomains } from "@/contexts/DomainProvider"
import { SlotLayout } from "./SlotLayout"
import { getSectionComponent } from "../sectionImplementations"
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
  const slotChildren: Record<string, ReactNode> = {}
  for (const spec of slotSpecs) {
    const SectionComponent = getSectionComponent(spec.sectionRef)
    slotChildren[spec.slotName] = (
      <SectionComponent feature={feature} config={spec.config} />
    )
  }

  // 6. Render sections in SlotLayout
  return (
    <SlotLayout layout={layoutTemplate} className={className}>
      {slotChildren}
    </SlotLayout>
  )
})

export default ComposablePhaseView

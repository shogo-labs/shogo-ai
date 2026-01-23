/**
 * Section Implementations Map (Generic Only)
 *
 * Maps implementationRef strings to their corresponding React section components.
 * This bridges slotContent data (from Wavesmith) to code-side implementations.
 *
 * This package includes ONLY generic sections that work with any schema.
 * Feature-specific sections (discovery, analysis, etc.) should be registered
 * by the consuming application.
 *
 * Section components render full sections of a phase view, receiving the current
 * feature session and optional configuration from slotContent entities.
 */

import type { ComponentType, ReactNode } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"

// Generic sections only
import { DynamicCompositionSection } from "./DynamicCompositionSection"
import { PlanPreviewSection } from "./PlanPreviewSection"
import { DataGridSection } from "./DataGridSection"
import { ChartSection } from "./ChartSection"
import { FormSection } from "./FormSection"
import { AppBarSection } from "./AppBarSection"
import { SideNavSection } from "./SideNavSection"
import { AppShellSection } from "./AppShellSection"
import { SectionBrowserSection } from "./SectionBrowserSection"

// Re-export SectionRendererProps from types.ts
export type { SectionRendererProps } from "../types"
import type { SectionRendererProps } from "../types"

/**
 * Fallback section component displayed when the requested section
 * implementation is not found in the map.
 */
function FallbackSection({ feature, config }: SectionRendererProps) {
  return (
    <div className="p-4 border border-dashed border-muted rounded">
      <p className="text-muted-foreground">Section not found</p>
    </div>
  )
}

/**
 * Map of implementationRef strings to React section components.
 *
 * This map contains ONLY generic section renderers:
 * - DataGridSection: Generic collection renderer
 * - FormSection: JSON Forms-based entity editor
 * - ChartSection: D3-based visualizations
 * - AppBarSection, SideNavSection, AppShellSection: App building
 * - DynamicCompositionSection: Hot registration support
 * - PlanPreviewSection: View builder plans
 * - SectionBrowserSection: Section browser
 *
 * Feature-specific sections should be added by the consuming application:
 * ```typescript
 * sectionImplementationMap.set("IntentTerminalSection", IntentTerminalSection)
 * ```
 */
export const sectionImplementationMap = new Map<
  string,
  ComponentType<SectionRendererProps>
>([
  // Dynamic composition rendering (enables hot registration)
  ["DynamicCompositionSection", DynamicCompositionSection],
  // View Builder sections
  ["PlanPreviewSection", PlanPreviewSection],
  // Data Grid section (generic collection renderer)
  ["DataGridSection", DataGridSection],
  // Chart section (D3-based visualizations)
  ["ChartSection", ChartSection],
  // Form section (JSON Forms-based entity editor)
  ["FormSection", FormSection],
  // App building sections
  ["AppBarSection", AppBarSection],
  ["SideNavSection", SideNavSection],
  ["AppShellSection", AppShellSection],
  ["SectionBrowserSection", SectionBrowserSection],
])

/**
 * Safely retrieves a section component by its implementationRef string.
 *
 * @param ref - The string key to look up in the map
 * @returns The corresponding React section component, or FallbackSection if not found
 */
export function getSectionComponent(
  ref: string
): ComponentType<SectionRendererProps> {
  if (!ref) {
    return FallbackSection
  }
  return sectionImplementationMap.get(ref) ?? FallbackSection
}

/**
 * Result from useDynamicSection hook
 */
export interface DynamicSectionResult {
  /** The resolved section component (always defined - returns FallbackSection if not found) */
  component: ComponentType<SectionRendererProps>
  /** Config to merge with existing config (e.g., compositionId for DynamicCompositionSection) */
  additionalConfig?: Record<string, unknown>
  /** Whether this was resolved via hot registration (dynamic lookup) */
  isHotRegistered: boolean
}

/**
 * Hook for resolving sections with hot registration fallback.
 *
 * Resolution order:
 * 1. First checks static sectionImplementationMap (fast path)
 * 2. Falls back to componentBuilder.componentDefinitionCollection.findByName()
 * 3. If found with implementationRef='DynamicCompositionSection', returns that
 *    component with the compositionId from the ComponentDefinition
 */
export function useDynamicSection(sectionName: string): DynamicSectionResult {
  // Access componentBuilder domain for hot registration fallback
  const domains = useDomains()
  const componentBuilder = (domains as any)?.componentBuilder

  // Fast path: Check static map first
  const staticComponent = sectionImplementationMap.get(sectionName)
  if (staticComponent) {
    return {
      component: staticComponent,
      isHotRegistered: false,
    }
  }

  // Hot registration fallback: Look up in componentBuilder
  if (componentBuilder?.componentDefinitionCollection?.findByName) {
    const componentDef = componentBuilder.componentDefinitionCollection.findByName(sectionName)

    if (componentDef && componentDef.implementationRef === "DynamicCompositionSection") {
      const composition = componentBuilder.compositionCollection?.findByName?.(sectionName)
      const compositionId = composition?.id

      return {
        component: DynamicCompositionSection,
        additionalConfig: compositionId ? { compositionId } : undefined,
        isHotRegistered: true,
      }
    }

    if (componentDef?.implementationRef) {
      const resolvedComponent = sectionImplementationMap.get(componentDef.implementationRef)
      if (resolvedComponent) {
        return {
          component: resolvedComponent,
          isHotRegistered: true,
        }
      }
    }
  }

  // Not found anywhere
  return {
    component: FallbackSection,
    isHotRegistered: false,
  }
}

/**
 * Props for DynamicSectionRenderer
 */
export interface DynamicSectionRendererProps {
  /** Section name to resolve (can be static or hot-registered) */
  sectionName: string
  /** The current feature session data */
  feature: any
  /** Optional configuration from slotContent */
  config?: Record<string, unknown>
}

/**
 * DynamicSectionRenderer - Wrapper component that enables hot registration in loops
 */
export const DynamicSectionRenderer = observer(function DynamicSectionRenderer({
  sectionName,
  feature,
  config,
}: DynamicSectionRendererProps): ReactNode {
  const { component: SectionComponent, additionalConfig } = useDynamicSection(sectionName)

  const mergedConfig = additionalConfig
    ? { ...additionalConfig, ...config }
    : config

  return <SectionComponent feature={feature} config={mergedConfig} />
})

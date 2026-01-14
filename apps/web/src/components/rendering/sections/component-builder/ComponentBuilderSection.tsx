/**
 * ComponentBuilderSection - Entry point for the component builder
 * Task: task-cb-ui-section-shell, task-cb-ui-builder-layout
 *
 * Invoked via set_workspace virtual tool. Renders either:
 * - 'definition' mode: Full builder with BuilderLayout
 * - 'preview' mode: Just the PreviewPanel for split-panel setups
 *
 * Container Pattern Rules:
 * - Internal state uses React useState
 * - Sub-components (BuilderLayout, PreviewPanel) are NOT registered separately
 * - All sub-components will be defined inside this file or as local imports
 *
 * @see CONTAINER_SECTION_PATTERN.md for pattern documentation
 */

import { observer } from "mobx-react-lite"
import type { SectionRendererProps } from "../../types"
import { ComponentBuilderProvider } from "./ComponentBuilderContext"
import { BuilderLayout } from "./BuilderLayout"
import { PreviewPanel } from "./PreviewPanel"

// =============================================================================
// Configuration Interface
// =============================================================================

/**
 * Configuration options for ComponentBuilderSection
 *
 * These options can be set via slotContent.config in composition entities
 * and modified at runtime via MCP store.update commands.
 *
 * @example
 * // In composition slotContent:
 * { slot: "main", component: "ComponentBuilderSection", config: {
 *   mode: "definition",
 *   compositionId: "comp-123",
 *   suggestedDataSource: { domain: "feature-session", model: "Task" },
 *   suggestedLayout: "kanban",
 *   suggestedGroupBy: "status"
 * }}
 */
export interface ComponentBuilderConfig {
  /**
   * Rendering mode for the component builder.
   * - 'definition': Full builder interface with BuilderLayout
   * - 'preview': Preview-only panel for split layouts
   * Default: 'definition'
   */
  mode?: "definition" | "preview"

  /**
   * ID of the composition being edited.
   * When set, the builder loads this composition for editing.
   */
  compositionId?: string

  /**
   * Suggested data source for new compositions.
   * Provided by the AI based on context analysis.
   */
  suggestedDataSource?: {
    domain: string
    model: string
  }

  /**
   * Suggested layout type for new compositions.
   * Provided by the AI based on data structure analysis.
   */
  suggestedLayout?: "kanban" | "grid" | "list"

  /**
   * Suggested groupBy field for kanban/grouped layouts.
   * Provided by the AI based on data model analysis.
   */
  suggestedGroupBy?: string
}

// =============================================================================
// Main Container Section Component
// =============================================================================

/**
 * ComponentBuilderSection - Container section for the Component Builder
 * Task: task-cb-ui-section-shell
 *
 * Features:
 * - Mode switching between definition and preview
 * - Config-driven suggestions from AI context
 * - Wrapped with observer() for MobX domain reactivity
 *
 * Future tasks will implement:
 * - BuilderLayout (definition mode)
 * - PreviewPanel (preview mode)
 *
 * @param feature - The current FeatureSession data
 * @param config - Optional configuration (supports mode, compositionId, suggestions)
 */
export const ComponentBuilderSection = observer(
  function ComponentBuilderSection({ feature, config }: SectionRendererProps) {
    const builderConfig = config as ComponentBuilderConfig
    const mode = builderConfig?.mode ?? "definition"

    // Preview mode - render just the preview panel (for split layouts)
    if (mode === "preview") {
      return (
        <ComponentBuilderProvider feature={feature} config={config}>
          <div data-testid="component-builder-preview" className="h-full">
            <PreviewPanel />
          </div>
        </ComponentBuilderProvider>
      )
    }

    // Definition mode - render full builder with BuilderLayout
    return (
      <ComponentBuilderProvider feature={feature} config={config}>
        <div data-testid="component-builder-section" className="h-full">
          <BuilderLayout />
        </div>
      </ComponentBuilderProvider>
    )
  }
)

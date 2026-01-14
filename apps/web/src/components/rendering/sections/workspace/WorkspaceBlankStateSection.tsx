/**
 * WorkspaceBlankStateSection
 * Task: req-wpp-layout-refactor
 *
 * Section wrapper for the workspace BlankState component.
 * Displays a centered welcome message when the workspace has no active content.
 *
 * This section is rendered by ComposablePhaseView when the workspace Composition
 * includes this section in its slotContent. When show_schema (or similar) is called,
 * the Composition is updated to replace this with actual content sections.
 */

import { observer } from "mobx-react-lite"
import { Sparkles } from "lucide-react"
import type { SectionRendererProps } from "../../types"

/**
 * WorkspaceBlankStateSection - Empty state for the dynamic workspace
 *
 * Features:
 * - Centered Sparkles icon
 * - Welcoming heading
 * - Supportive subtext
 * - Wrapped with observer() for MobX compatibility
 */
export const WorkspaceBlankStateSection = observer(function WorkspaceBlankStateSection({
  feature,
  config,
}: SectionRendererProps) {
  return (
    <div
      data-testid="workspace-blank-state-section"
      className="h-full flex items-center justify-center"
    >
      <div className="text-center max-w-md">
        <Sparkles className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
        <h2 className="text-xl font-semibold mb-2">How can I help you build today?</h2>
        <p className="text-muted-foreground">
          Describe what you want to create, explore, or analyze. Use the chat to ask
          Claude to show schemas, create visualizations, or help you build your project.
        </p>
      </div>
    </div>
  )
})

export default WorkspaceBlankStateSection

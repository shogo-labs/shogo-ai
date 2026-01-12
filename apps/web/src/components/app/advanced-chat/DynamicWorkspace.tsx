/**
 * DynamicWorkspace Component
 *
 * Renders a workspace with configurable panel layouts.
 * Shows BlankState when no panels are open, otherwise displays
 * panels in a grid based on the layout prop.
 *
 * Task: task-testbed-workspace
 * Feature: virtual-tools-domain
 */

import { BlankState } from "./BlankState"
import { WorkspacePanel } from "./WorkspacePanel"
import type { WorkspacePanelData } from "./WorkspacePanel"

/**
 * Props for the DynamicWorkspace component
 */
export interface DynamicWorkspaceProps {
  /** Array of panels to render */
  panels: WorkspacePanelData[]
  /** Layout mode for panel arrangement */
  layout: "single" | "split-h" | "split-v" | "grid"
  /** Callback when a panel is closed */
  onPanelClose: (panelId: string) => void
  /** Optional callback when a panel is resized */
  onPanelResize?: (panelId: string, size: number) => void
}

/**
 * DynamicWorkspace - Manages the workspace panel layout system.
 *
 * When panels array is empty, displays BlankState component.
 * When panels exist, renders them in a grid based on the layout prop:
 * - single: flex column (one panel takes full space)
 * - split-h: 2 columns side by side
 * - split-v: 2 rows stacked vertically
 * - grid: 2x2 grid layout
 */
export function DynamicWorkspace({
  panels,
  layout,
  onPanelClose,
}: DynamicWorkspaceProps) {
  // If no panels, show BlankState
  if (panels.length === 0) {
    return <BlankState />
  }

  // Layout classes based on layout prop
  const layoutClasses: Record<DynamicWorkspaceProps["layout"], string> = {
    single: "flex flex-col",
    "split-h": "grid grid-cols-2 gap-4",
    "split-v": "grid grid-rows-2 gap-4",
    grid: "grid grid-cols-2 grid-rows-2 gap-4",
  }

  return (
    <div className={`h-full p-4 ${layoutClasses[layout]}`}>
      {panels.map((panel) => (
        <WorkspacePanel
          key={panel.id}
          panel={panel}
          onClose={() => onPanelClose(panel.id)}
        />
      ))}
    </div>
  )
}

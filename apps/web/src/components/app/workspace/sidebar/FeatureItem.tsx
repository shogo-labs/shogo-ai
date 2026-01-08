/**
 * FeatureItem Component
 * Task: task-2-2-005, task-delete-003-feature-item-menu, sidebar-pipeline-precision-redesign
 *
 * Renders a clickable feature row with underlaid progress bar.
 * Progress fills horizontally based on phase (1-8 = 12.5% each).
 * Phase badges removed - progress visualization replaces them.
 *
 * Props:
 * - feature: Feature object with id, name, status
 * - isSelected: Whether this item is currently selected
 * - onClick: Callback when item is clicked (selection)
 * - onDelete: Callback when delete is triggered from menu
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { MoreVertical, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

/**
 * Feature type for sidebar display
 */
export interface Feature {
  id: string
  name: string
  status: string
  intent?: string
}

/**
 * Props for FeatureItem component
 */
export interface FeatureItemProps {
  /** Feature to display */
  feature: Feature
  /** Whether this item is currently selected */
  isSelected: boolean
  /** Callback when item is clicked */
  onClick: () => void
  /** Callback when delete action is triggered */
  onDelete?: () => void
}

/**
 * Phase index mapping for progress width calculation
 * Each phase represents 12.5% of the progress bar
 */
const PHASE_INDEX: Record<string, number> = {
  discovery: 1,
  analysis: 2,
  classification: 3,
  design: 4,
  spec: 5,
  testing: 6,
  implementation: 7,
  complete: 8,
}

/**
 * Phase color CSS variable mapping
 */
const PHASE_COLOR_VAR: Record<string, string> = {
  discovery: "var(--phase-discovery)",
  analysis: "var(--phase-analysis)",
  classification: "var(--phase-classification)",
  design: "var(--phase-design)",
  spec: "var(--phase-spec)",
  testing: "var(--phase-testing)",
  implementation: "var(--phase-implementation)",
  complete: "var(--phase-complete)",
}

/**
 * Calculate progress width percentage from phase
 */
function getProgressWidth(phase: string): string {
  const index = PHASE_INDEX[phase] ?? 1
  return `${(index / 8) * 100}%`
}

/**
 * FeatureItem Component
 *
 * Renders a single feature as a clickable row in the sidebar.
 * Shows feature name with underlaid progress bar indicating pipeline position.
 * Progress fills from left based on current phase (12.5% per phase).
 * Highlights when selected using bg-accent layered with progress.
 * Includes action menu with delete option.
 */
export function FeatureItem({ feature, isSelected, onClick, onDelete }: FeatureItemProps) {
  const phase = feature.status.toLowerCase()
  const progressWidth = getProgressWidth(phase)
  const phaseColor = PHASE_COLOR_VAR[phase] ?? PHASE_COLOR_VAR.discovery

  return (
    <div
      className={cn(
        "feature-item group w-full flex items-center gap-1 pr-1 rounded-md transition-colors",
        "hover:bg-accent/30",
        isSelected && "bg-accent"
      )}
      data-testid={`feature-item-${feature.id}`}
      data-phase={phase}
      data-selected={isSelected}
      style={{
        "--phase-color": phaseColor,
        "--progress-width": progressWidth,
      } as React.CSSProperties}
    >
      {/* Main clickable area for selection - z-index above progress fill */}
      <button
        type="button"
        onClick={onClick}
        className="relative z-[1] flex-1 flex items-center gap-2 px-3 py-2 text-left text-sm min-w-0"
        aria-selected={isSelected}
      >
        <span
          className="truncate flex-1 text-foreground"
          style={{ fontFamily: "var(--font-body)" }}
        >
          {feature.name}
        </span>
      </button>

      {/* Action menu - visible on hover or when selected */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "relative z-[2] h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0",
              isSelected && "opacity-100"
            )}
            onClick={(e) => e.stopPropagation()}
            aria-label="Feature actions"
          >
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            variant="destructive"
            onClick={onDelete}
            className="cursor-pointer"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

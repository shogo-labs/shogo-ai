/**
 * NewFeatureButton Component
 * Task: task-2-2-005
 *
 * Button to create a new feature. Positioned at the sidebar footer.
 * Uses shadcn Button component with Plus icon.
 * Disabled when no project is selected.
 *
 * Props:
 * - onClick: Callback when button is clicked
 * - disabled: Whether button is disabled (e.g., no project selected)
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/sidebar/
 * - Zero imports from /components/Studio/
 */

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Props for NewFeatureButton component
 */
export interface NewFeatureButtonProps {
  /** Callback when button is clicked */
  onClick: () => void
  /** Whether button is disabled (e.g., no project selected) */
  disabled?: boolean
}

/**
 * NewFeatureButton Component
 *
 * Renders a full-width button to create a new feature.
 * Shows Plus icon and "New Feature" text.
 * Includes title attribute explaining why button may be disabled.
 */
export function NewFeatureButton({ onClick, disabled = false }: NewFeatureButtonProps) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      className="w-full"
      title={disabled ? "Select a project to create a feature" : "Create a new feature"}
      aria-label={disabled ? "New Feature (disabled - select a project first)" : "New Feature"}
      data-testid="new-feature-button"
    >
      <Plus className="h-4 w-4 mr-2" />
      New Feature
    </Button>
  )
}

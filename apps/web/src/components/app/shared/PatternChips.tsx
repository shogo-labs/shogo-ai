/**
 * PatternChips Component
 * Task: task-2-3b-005
 *
 * Displays a list of applicable patterns as horizontal flex-wrap chips.
 *
 * Props:
 * - patterns: Array of pattern names
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/shared/ for reuse across phase views
 * - Subtle outlined badge styling per vault 06-component-modules.md
 */

import { cn } from "@/lib/utils"

/**
 * Props for PatternChips component
 */
export interface PatternChipsProps {
  /** Array of pattern names to display */
  patterns: string[]
}

/**
 * PatternChips Component
 *
 * Displays patterns as a horizontal flex-wrap list of subtle chip badges.
 */
export function PatternChips({ patterns }: PatternChipsProps) {
  // Handle empty or undefined patterns
  if (!patterns || patterns.length === 0) {
    return null
  }

  return (
    <div
      data-testid="pattern-chips"
      className="flex flex-wrap gap-2"
    >
      {patterns.map((pattern) => (
        <span
          key={pattern}
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
            "border border-muted-foreground/30",
            "bg-muted/50 text-muted-foreground",
            "dark:bg-muted/20 dark:border-muted-foreground/20"
          )}
        >
          {pattern}
        </span>
      ))}
    </div>
  )
}

/**
 * EvidenceChecklist Component
 * Task: task-2-3b-006
 *
 * Displays classification evidence as key-value pairs with check/x icons.
 *
 * Props:
 * - evidence: Record<string, boolean> of evidence key-value pairs
 *
 * Per design-2-3b-component-hierarchy:
 * - Built in /components/app/shared/ for reuse across phase views
 * - Uses lucide-react icons (CheckCircle2, XCircle)
 */

import { CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Props for EvidenceChecklist component
 */
export interface EvidenceChecklistProps {
  /** Evidence key-value pairs */
  evidence?: Record<string, boolean>
}

/**
 * Transform camelCase key to space-separated display text
 * e.g., "hasExternalApi" -> "Has External Api"
 */
function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

/**
 * EvidenceChecklist Component
 *
 * Displays evidence as a vertical list with CheckCircle (green) for true
 * and XCircle (red) for false values.
 */
export function EvidenceChecklist({ evidence }: EvidenceChecklistProps) {
  // Handle undefined or empty evidence
  if (!evidence || Object.keys(evidence).length === 0) {
    return (
      <div
        data-testid="evidence-checklist"
        className="text-sm text-muted-foreground italic"
      >
        No evidence available
      </div>
    )
  }

  return (
    <div
      data-testid="evidence-checklist"
      className="space-y-2"
    >
      {Object.entries(evidence).map(([key, value]) => (
        <div
          key={key}
          className={cn(
            "flex items-center gap-2 text-sm",
            !value && "opacity-60"
          )}
        >
          {value ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
          )}
          <span className={cn(
            "text-foreground",
            !value && "text-muted-foreground"
          )}>
            {formatKey(key)}
          </span>
        </div>
      ))}
    </div>
  )
}

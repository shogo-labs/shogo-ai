/**
 * DataCard Component
 * Task: task-w1-data-card-primitive
 *
 * A versatile card component for displaying domain entities:
 * - finding: Analysis findings with location and recommendation
 * - requirement: Requirements with priority indicator
 * - deliverable: Completion items with status
 * - decision: Design decisions with rationale
 */

import { memo, useState, type ReactNode } from "react"
import { cn } from "../../utils/cn"
import { phaseColorVariants, type PhaseType } from "../../utils/variants"
import { ChevronDown, ChevronUp } from "lucide-react"

/**
 * DataCard variant types
 */
export type DataCardVariant = "finding" | "requirement" | "deliverable" | "decision"

/**
 * DataCard component props
 */
export interface DataCardProps {
  /** Card title */
  title: string
  /** Card description or summary */
  description: string
  /** Card variant type */
  variant?: DataCardVariant
  /** Phase for phase-colored accent */
  phase?: PhaseType
  /** Optional icon element */
  icon?: ReactNode
  /** Whether the card has expandable content */
  expandable?: boolean
  /** Whether the card is interactive (clickable) */
  interactive?: boolean
  /** Additional CSS classes */
  className?: string
  /** Expandable content */
  children?: ReactNode
  /** Optional metadata displayed in header */
  metadata?: ReactNode
  /** Click handler for interactive cards */
  onClick?: () => void
}

/**
 * Get variant-specific styling
 */
function getVariantStyles(variant: DataCardVariant | undefined): string {
  switch (variant) {
    case "finding":
      return "border-l-4 border-l-violet-500/50"
    case "requirement":
      return "border-l-4 border-l-amber-500/50"
    case "deliverable":
      return "border-l-4 border-l-emerald-500/50"
    case "decision":
      return "border-l-4 border-l-blue-500/50"
    default:
      return ""
  }
}

/**
 * Get phase-specific border color
 */
function getPhaseBorderClass(phase: PhaseType | undefined): string {
  if (!phase) return ""
  return phaseColorVariants({ phase, variant: "border" })
}

/**
 * DataCard component
 *
 * @example
 * ```tsx
 * // Simple card
 * <DataCard
 *   title="Finding Title"
 *   description="A pattern was discovered..."
 *   variant="finding"
 * />
 *
 * // Expandable card with phase accent
 * <DataCard
 *   title="Requirement"
 *   description="Must support..."
 *   variant="requirement"
 *   phase="discovery"
 *   expandable
 * >
 *   <p>Additional details here...</p>
 * </DataCard>
 *
 * // Interactive card
 * <DataCard
 *   title="Decision"
 *   description="We chose to..."
 *   variant="decision"
 *   interactive
 *   onClick={() => console.log("clicked")}
 * />
 * ```
 */
export const DataCard = memo(function DataCard({
  title,
  description,
  variant,
  phase,
  icon,
  expandable = false,
  interactive = false,
  className,
  children,
  metadata,
  onClick,
}: DataCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const handleToggleExpand = () => {
    setIsExpanded(prev => !prev)
  }

  const handleClick = () => {
    if (interactive && onClick) {
      onClick()
    }
  }

  const baseClasses = cn(
    "rounded-lg border bg-card p-4",
    "transition-all duration-200",
    getVariantStyles(variant),
    phase && getPhaseBorderClass(phase),
    interactive && [
      "cursor-pointer",
      "hover:bg-accent/50 hover:shadow-md",
      "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
    ],
    className
  )

  return (
    <div
      className={baseClasses}
      data-variant={variant || "default"}
      data-phase={phase}
      onClick={handleClick}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? "button" : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {icon && (
            <div className="flex-shrink-0 text-muted-foreground">
              {icon}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground truncate">
              {title}
            </h3>
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {description}
            </p>
          </div>
        </div>

        {/* Metadata and expand toggle */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {metadata && (
            <div className="text-sm text-muted-foreground">
              {metadata}
            </div>
          )}
          {expandable && (
            <button
              type="button"
              data-expand-button
              aria-expanded={isExpanded}
              onClick={(e) => {
                e.stopPropagation()
                handleToggleExpand()
              }}
              className={cn(
                "p-1 rounded-md",
                "text-muted-foreground hover:text-foreground",
                "hover:bg-accent/50",
                "transition-colors duration-150"
              )}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expandable content */}
      {expandable && children && (
        <div
          data-expanded={isExpanded}
          className={cn(
            "overflow-hidden transition-all duration-200",
            isExpanded ? "mt-4 max-h-96 opacity-100" : "max-h-0 opacity-0"
          )}
        >
          <div className="pt-4 border-t border-border">
            {children}
          </div>
        </div>
      )}

      {/* Non-expandable children */}
      {!expandable && children && (
        <div className="mt-4 pt-4 border-t border-border">
          {children}
        </div>
      )}
    </div>
  )
})

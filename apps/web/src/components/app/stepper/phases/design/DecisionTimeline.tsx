/**
 * DecisionTimeline Component
 * Task: task-w3-decision-timeline
 *
 * Displays design decisions in a horizontal scrollable timeline layout
 * with selection state. Each decision is shown as a timeline node that
 * can be clicked to view full details in a StructuredDecisionCard.
 *
 * Features:
 * - Horizontal scrollable layout with decision nodes
 * - Selection state highlights selected decision
 * - StructuredDecisionCard shows full decision details
 * - ImpactEntityTags link to affected entities in schema
 *
 * Uses phase-design amber color tokens for consistent styling.
 */

import { useState, useRef } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { Circle, CheckCircle2 } from "lucide-react"
import { StructuredDecisionCard, type DesignDecisionData } from "./StructuredDecisionCard"
import type { EntityReference } from "./ImpactEntityTags"

/**
 * Props for DecisionTimeline component
 */
export interface DecisionTimelineProps {
  /** Feature/session ID to query decisions for */
  featureId: string
  /** Callback when an entity tag is clicked in the detail view */
  onEntityClick?: (entity: EntityReference) => void
  /** Additional CSS classes */
  className?: string
}

/**
 * Props for individual timeline node
 */
interface TimelineNodeProps {
  /** Decision data */
  decision: DesignDecisionData
  /** Whether this node is selected */
  isSelected: boolean
  /** Click handler */
  onClick: () => void
  /** Whether this is the first node */
  isFirst: boolean
  /** Whether this is the last node */
  isLast: boolean
}

/**
 * TimelineNode Component
 *
 * Individual node in the decision timeline representing a single decision.
 * Shows decision name/label with visual indicator for selection state.
 */
function TimelineNode({
  decision,
  isSelected,
  onClick,
  isFirst,
  isLast,
}: TimelineNodeProps) {
  return (
    <div className="flex flex-col items-center min-w-[120px]">
      {/* Connector line before (unless first) */}
      <div className="flex items-center w-full">
        {!isFirst && (
          <div className="flex-1 h-0.5 bg-amber-500/30" />
        )}
        {isFirst && <div className="flex-1" />}

        {/* Node circle */}
        <button
          onClick={onClick}
          className={cn(
            "flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all",
            "hover:scale-110 hover:shadow-md",
            isSelected
              ? "bg-amber-500 border-amber-500 text-white shadow-amber-500/30 shadow-lg"
              : "bg-background border-amber-500/50 text-amber-500 hover:border-amber-500"
          )}
          aria-label={`Select decision: ${decision.name}`}
          aria-pressed={isSelected}
        >
          {isSelected ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Circle className="h-4 w-4" />
          )}
        </button>

        {/* Connector line after (unless last) */}
        {!isLast && (
          <div className="flex-1 h-0.5 bg-amber-500/30" />
        )}
        {isLast && <div className="flex-1" />}
      </div>

      {/* Decision label */}
      <div
        className={cn(
          "mt-2 text-xs text-center max-w-[100px] truncate cursor-pointer",
          isSelected
            ? "text-amber-600 dark:text-amber-400 font-medium"
            : "text-muted-foreground"
        )}
        onClick={onClick}
        title={decision.name}
      >
        {decision.name}
      </div>
    </div>
  )
}

/**
 * DecisionTimeline Component
 *
 * Main timeline component that displays all design decisions for a feature
 * in a horizontal scrollable layout. Clicking a node shows its full details
 * in a StructuredDecisionCard below.
 *
 * @example
 * ```tsx
 * <DecisionTimeline
 *   featureId="session-my-feature"
 *   onEntityClick={(entity) => selectEntityInGraph(entity.id)}
 * />
 * ```
 */
export const DecisionTimeline = observer(function DecisionTimeline({
  featureId,
  onEntityClick,
  className,
}: DecisionTimelineProps) {
  const { platformFeatures } = useDomains()
  const phaseColors = usePhaseColor("design")

  // State for selected decision
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Query design decisions for this feature session
  // Filter out enhancement-hooks-plan (shown in separate tab)
  //
  // PERF FIX: Use refs to track both the key AND the result.
  // MobX observable references in useMemo deps defeat memoization - any observable
  // change triggers re-render, and React sees a "new" collection reference.
  // Instead, we manually compare a stable key derived from the actual data.
  const prevDecisionsKeyRef = useRef<string>('')
  const decisionsRef = useRef<DesignDecisionData[]>([])

  // Get all decisions and compute a stable key
  const allDecisions = platformFeatures?.designDecisionCollection?.all() ?? []
  const filteredDecisions = allDecisions.filter(
    (d: any) =>
      d.session?.id === featureId && d.name !== "enhancement-hooks-plan"
  )
  // Key includes IDs and updatedAt timestamps of relevant decisions
  const currentDecisionsKey = `${featureId}:${filteredDecisions.map(
    (d: any) => `${d.id}:${d.updatedAt ?? ''}`
  ).join('|')}`

  // Only recompute when key actually changes
  if (currentDecisionsKey !== prevDecisionsKeyRef.current) {
    prevDecisionsKeyRef.current = currentDecisionsKey
    decisionsRef.current = filteredDecisions
      .sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .map((d: any): DesignDecisionData => ({
        id: d.id,
        name: d.name,
        question: d.question,
        decision: d.decision,
        rationale: d.rationale,
        // In future: extract affected entities from decision text or add to schema
        affectedEntities: extractAffectedEntities(d),
      }))
  }

  const decisions = decisionsRef.current

  // Find selected decision (simple lookup, no memoization needed)
  const selectedDecision = selectedId
    ? decisions.find((d) => d.id === selectedId) ?? null
    : null

  // Handle node click
  const handleSelectDecision = (decisionId: string) => {
    setSelectedId((prev) => (prev === decisionId ? null : decisionId))
  }

  // Empty state
  if (decisions.length === 0) {
    return (
      <div
        data-testid="decision-timeline"
        className={cn(
          "flex flex-col items-center justify-center p-8 text-center",
          className
        )}
      >
        <p className="text-muted-foreground">
          No design decisions recorded for this feature.
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="decision-timeline"
      className={cn("flex flex-col gap-6", className)}
    >
      {/* Timeline container with horizontal scroll */}
      <div className="overflow-x-auto pb-4">
        <div className="flex flex-row items-start min-w-max px-4">
          {decisions.map((decision, index) => (
            <TimelineNode
              key={decision.id}
              decision={decision}
              isSelected={decision.id === selectedId}
              onClick={() => handleSelectDecision(decision.id)}
              isFirst={index === 0}
              isLast={index === decisions.length - 1}
            />
          ))}
        </div>
      </div>

      {/* Selected decision detail card */}
      {selectedDecision && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
          <StructuredDecisionCard
            decision={selectedDecision}
            onEntityClick={onEntityClick}
          />
        </div>
      )}
    </div>
  )
})

/**
 * Extract affected entities from decision text
 *
 * This is a placeholder implementation. In a full implementation,
 * this could:
 * 1. Parse entity names from decision/rationale text
 * 2. Look up entities mentioned in a dedicated field
 * 3. Use NLP to extract entity references
 *
 * For now, we extract capitalized words that look like entity names.
 */
function extractAffectedEntities(decision: any): EntityReference[] {
  // Combine all text fields to search
  const text = `${decision.decision ?? ""} ${decision.rationale ?? ""}`

  // Simple heuristic: find PascalCase words (likely entity names)
  const entityPattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g
  const matches = text.match(entityPattern) ?? []

  // Deduplicate and create entity references
  const uniqueNames = [...new Set(matches)]
  return uniqueNames.slice(0, 5).map((name) => ({
    id: name,
    name,
    type: "model" as const,
  }))
}

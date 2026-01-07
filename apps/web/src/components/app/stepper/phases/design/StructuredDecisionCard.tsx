/**
 * StructuredDecisionCard Component
 * Task: task-w3-decision-timeline
 *
 * Displays a design decision in a structured format with clearly
 * labeled sections: Question, Decision, Rationale, and Impact.
 *
 * Enhanced version of DesignDecisionCard with better visual hierarchy
 * and integration with ImpactEntityTags for showing affected entities.
 *
 * Uses phase-design amber color tokens for consistent styling.
 */

import { memo } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { HelpCircle, CheckCircle, MessageSquare, Target } from "lucide-react"
import { ImpactEntityTags, type EntityReference } from "./ImpactEntityTags"

/**
 * Design decision data structure
 */
export interface DesignDecisionData {
  /** Unique identifier */
  id: string
  /** Decision name/title */
  name: string
  /** The question being addressed */
  question: string
  /** The decision made */
  decision: string
  /** Reasoning behind the decision */
  rationale: string
  /** Optional: entities affected by this decision */
  affectedEntities?: EntityReference[]
}

/**
 * Props for StructuredDecisionCard component
 */
export interface StructuredDecisionCardProps {
  /** The decision to display */
  decision: DesignDecisionData
  /** Callback when an affected entity is clicked */
  onEntityClick?: (entity: EntityReference) => void
  /** Additional CSS classes */
  className?: string
}

/**
 * Section label component for consistent styling
 */
function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: React.ElementType
  label: string
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="h-4 w-4 text-amber-500" />
      <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
        {label}
      </span>
    </div>
  )
}

/**
 * StructuredDecisionCard Component
 *
 * Renders a design decision with structured sections for better
 * readability and comprehension.
 *
 * @example
 * ```tsx
 * <StructuredDecisionCard
 *   decision={{
 *     id: "dec-001",
 *     name: "Data Storage Strategy",
 *     question: "How should we persist user data?",
 *     decision: "Use PostgreSQL with JSON columns for flexibility.",
 *     rationale: "Provides ACID compliance with schema flexibility.",
 *     affectedEntities: [{ id: "User", name: "User", type: "model" }],
 *   }}
 *   onEntityClick={(entity) => selectEntity(entity.id)}
 * />
 * ```
 */
export const StructuredDecisionCard = memo(function StructuredDecisionCard({
  decision,
  onEntityClick,
  className,
}: StructuredDecisionCardProps) {
  return (
    <Card
      data-testid="structured-decision-card"
      className={cn(
        "border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent",
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">
          {decision.name}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Question Section */}
        <div>
          <SectionLabel icon={HelpCircle} label="Question" />
          <p className="text-sm text-muted-foreground italic pl-6">
            {decision.question}
          </p>
        </div>

        <Separator className="bg-amber-500/20" />

        {/* Decision Section */}
        <div>
          <SectionLabel icon={CheckCircle} label="Decision" />
          <p className="text-sm text-foreground pl-6">
            {decision.decision}
          </p>
        </div>

        <Separator className="bg-amber-500/20" />

        {/* Rationale Section */}
        <div>
          <SectionLabel icon={MessageSquare} label="Rationale" />
          <p className="text-sm text-muted-foreground pl-6">
            {decision.rationale}
          </p>
        </div>

        {/* Impact Section (only if entities present) */}
        {decision.affectedEntities && decision.affectedEntities.length > 0 && (
          <>
            <Separator className="bg-amber-500/20" />
            <div>
              <SectionLabel icon={Target} label="Impact" />
              <div className="pl-6">
                <ImpactEntityTags
                  entities={decision.affectedEntities}
                  onEntityClick={onEntityClick}
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
})

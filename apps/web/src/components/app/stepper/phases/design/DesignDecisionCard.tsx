/**
 * DesignDecisionCard Component
 * Task: task-2-3c-009
 *
 * Displays a single DesignDecision with question, decision, and rationale fields
 * using shadcn Card components.
 *
 * Per design-2-3c-009:
 * - Uses shadcn Card with CardHeader and CardContent
 * - CardHeader shows decision.name as title
 * - Shows decision.question in text-muted-foreground italic
 * - Shows decision.decision as main content
 * - Shows decision.rationale in smaller text
 */

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

/**
 * DesignDecision entity type
 */
export interface DesignDecision {
  id: string
  name: string
  question: string
  decision: string
  rationale: string
}

/**
 * Props for DesignDecisionCard component
 */
export interface DesignDecisionCardProps {
  decision: DesignDecision
}

/**
 * DesignDecisionCard Component
 *
 * Renders a single design decision in a compact card format for list display.
 */
export function DesignDecisionCard({ decision }: DesignDecisionCardProps) {
  return (
    <Card data-testid={`design-decision-card-${decision.id}`}>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {decision.name}
        </CardTitle>
        <p className="text-muted-foreground text-sm italic">
          {decision.question}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-foreground">
          {decision.decision}
        </p>
        <p className="text-sm text-muted-foreground">
          {decision.rationale}
        </p>
      </CardContent>
    </Card>
  )
}

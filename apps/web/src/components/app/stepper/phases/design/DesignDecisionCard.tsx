/**
 * DesignDecisionCard Component
 * Task: task-2-3c-009 (original), task-cbe-006 (PropertyRenderer conversion)
 *
 * Displays a single DesignDecision with question, decision, and rationale fields
 * using shadcn Card components and PropertyRenderer for data-driven rendering.
 *
 * Per design-2-3c-009:
 * - Uses shadcn Card with CardHeader and CardContent
 * - CardHeader shows decision.name as title
 * - Shows decision.question in text-muted-foreground italic
 * - Shows decision.decision as main content
 * - Shows decision.rationale in smaller text
 *
 * Per task-cbe-006 (PropertyRenderer conversion):
 * - All text fields use PropertyRenderer with PropertyMetadata
 * - question, decision, rationale use xRenderer: 'long-text' with expandable: true
 * - Enables Claude to reshape UI via MCP binding modifications
 */

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { PropertyRenderer } from "@/components/rendering"
import type { PropertyMetadata } from "@/components/rendering"

/**
 * PropertyMetadata for the name field (title)
 */
const nameMeta: PropertyMetadata = {
  name: "name",
  type: "string"
}

/**
 * PropertyMetadata for the question field
 * Uses long-text renderer for expand/collapse on long content
 */
const questionMeta: PropertyMetadata = {
  name: "question",
  type: "string",
  xRenderer: "long-text"
}

/**
 * PropertyMetadata for the decision field
 * Uses long-text renderer for expand/collapse on long content
 */
const decisionMeta: PropertyMetadata = {
  name: "decision",
  type: "string",
  xRenderer: "long-text"
}

/**
 * PropertyMetadata for the rationale field
 * Uses long-text renderer for expand/collapse on long content
 */
const rationaleMeta: PropertyMetadata = {
  name: "rationale",
  type: "string",
  xRenderer: "long-text"
}

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
 * Uses PropertyRenderer for all text fields to enable data-driven UI reshaping.
 */
export function DesignDecisionCard({ decision }: DesignDecisionCardProps) {
  return (
    <Card data-testid={`design-decision-card-${decision.id}`}>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          <PropertyRenderer value={decision.name} property={nameMeta} />
        </CardTitle>
        <div className="text-muted-foreground text-sm italic">
          <PropertyRenderer value={decision.question} property={questionMeta} config={{ expandable: true }} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-foreground">
          <PropertyRenderer value={decision.decision} property={decisionMeta} config={{ expandable: true }} />
        </div>
        <div className="text-sm text-muted-foreground">
          <PropertyRenderer value={decision.rationale} property={rationaleMeta} config={{ expandable: true }} />
        </div>
      </CardContent>
    </Card>
  )
}

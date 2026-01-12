/**
 * InitialAssessmentSection Component
 * Task: task-cpv-007
 *
 * Renders the initialAssessment object from a feature session with:
 * - Archetype badge at top
 * - Dual column grid for indicators/uncertainties
 * - CheckCircle icons for indicators (green)
 * - HelpCircle icons for uncertainties (amber)
 *
 * Extracted from DiscoveryView.tsx pattern for reuse in composable phase views.
 */

import { cn } from "@/lib/utils"
import { CheckCircle, HelpCircle } from "lucide-react"
import {
  ArchetypeBadge,
  type FeatureArchetype,
} from "@/components/app/shared"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * AssessmentColumn Component
 * Single column for indicators or uncertainties
 */
function AssessmentColumn({
  title,
  items,
  icon: Icon,
  iconColor,
  testId,
}: {
  title: string
  items: string[]
  icon: React.ComponentType<{ className?: string }>
  iconColor: string
  testId: string
}) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Icon className={cn("h-4 w-4", iconColor)} />
        {title}
      </h4>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item, index) => (
            <li
              key={index}
              className="flex items-start gap-2 text-sm text-muted-foreground"
            >
              <Icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", iconColor)} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground/60 italic">None identified</p>
      )}
    </div>
  )
}

/**
 * InitialAssessmentSection Component
 *
 * Displays the Initial Assessment section with:
 * 1. Archetype Badge - Shows likelyArchetype with color-coded styling
 * 2. Dual Column Layout - Indicators vs Uncertainties with appropriate icons
 */
export function InitialAssessmentSection({ feature, config }: SectionRendererProps) {
  const { initialAssessment } = feature || {}

  // Handle missing initialAssessment gracefully
  if (!initialAssessment) {
    return (
      <section data-testid="initial-assessment-section" className="space-y-4">
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No initial assessment available
          </p>
        </div>
      </section>
    )
  }

  const {
    likelyArchetype,
    indicators = [],
    uncertainties = [],
  } = initialAssessment

  return (
    <section data-testid="initial-assessment-section" className="space-y-4">
      {/* Archetype Badge */}
      {likelyArchetype && (
        <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg">
          <span className="text-sm text-muted-foreground">Likely Archetype:</span>
          <ArchetypeBadge archetype={likelyArchetype as FeatureArchetype} size="md" />
        </div>
      )}

      {/* Dual Column: Indicators vs Uncertainties */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-muted/20 rounded-lg">
        <AssessmentColumn
          title="Indicators"
          items={indicators}
          icon={CheckCircle}
          iconColor="text-green-500"
          testId="indicators-column"
        />
        <AssessmentColumn
          title="Uncertainties"
          items={uncertainties}
          icon={HelpCircle}
          iconColor="text-amber-500"
          testId="uncertainties-column"
        />
      </div>
    </section>
  )
}

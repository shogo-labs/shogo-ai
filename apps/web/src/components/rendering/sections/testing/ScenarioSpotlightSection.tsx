/**
 * ScenarioSpotlightSection
 * Task: task-testing-005
 *
 * Displays selected test specification in large format with Given/When/Then sections.
 * Part of the composable Testing phase view.
 *
 * Features:
 * - Uses useTestingPanelContext to get selectedSpec and clearSelectedSpec
 * - Returns null when selectedSpec is null (conditional render)
 * - Container uses p-5 rounded-lg border-2 border-cyan-500/50 bg-card styling
 * - Header shows test type badge via PropertyRenderer with testTypePropertyMeta
 * - Header shows requirement link if spec.requirement exists
 * - Header shows scenario name in text-lg font-semibold text-foreground
 * - Close button (X icon h-4 w-4) in top-right calls clearSelectedSpec on click
 * - Given/When/Then sections with proper label styling
 * - PropertyRenderer config uses size='sm' and layout='compact'
 * - Sections only render when respective spec properties have content
 */

import { observer } from "mobx-react-lite"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { PropertyRenderer } from "../../PropertyRenderer"
import { useTestingPanelContext } from "./TestingPanelContext"
import { usePhaseColorFromContext } from "../shared"
import type { SectionRendererProps } from "../../types"
import type { PropertyMetadata } from "../../types"

/**
 * Property metadata for test type badge rendering
 */
const testTypePropertyMeta: PropertyMetadata = {
  name: "testType",
  type: "string",
  xRenderer: "test-type-badge",
}

/**
 * Property metadata for given array rendering
 */
const givenPropertyMeta: PropertyMetadata = {
  name: "given",
  type: "array",
  xRenderer: "string-array",
}

/**
 * Property metadata for then array rendering
 */
const thenPropertyMeta: PropertyMetadata = {
  name: "then",
  type: "array",
  xRenderer: "string-array",
}

/**
 * PropertyRenderer config for compact display
 */
const compactConfig = {
  size: "sm",
  layout: "compact",
}

/**
 * ScenarioSpotlightSection - Displays selected test spec in detail
 *
 * Shows the selected TestSpecification with Given/When/Then sections in a
 * highlighted spotlight panel. Returns null when no spec is selected.
 */
export const ScenarioSpotlightSection = observer(function ScenarioSpotlightSection({
  feature,
  config,
}: SectionRendererProps) {
  const { selectedSpec, clearSelectedSpec } = useTestingPanelContext()
  const phaseColors = usePhaseColorFromContext()

  // Return null when no spec is selected
  if (!selectedSpec) {
    return null
  }

  const hasGiven = selectedSpec.given && selectedSpec.given.length > 0
  const hasWhen = selectedSpec.when && selectedSpec.when.length > 0
  const hasThen = selectedSpec.then && selectedSpec.then.length > 0

  return (
    <div
      data-testid="scenario-spotlight"
      className={cn(
        "p-5 rounded-lg border-2 border-cyan-500/50 bg-card relative"
      )}
    >
      {/* Close button */}
      <button
        onClick={clearSelectedSpec}
        className="absolute top-3 right-3 p-1 rounded hover:bg-muted transition-colors"
        aria-label="Close spotlight"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Header */}
      <div className="flex items-start gap-3 mb-4 pr-8">
        {/* Test type badge */}
        <PropertyRenderer
          property={testTypePropertyMeta}
          value={selectedSpec.testType}
          config={compactConfig}
        />

        <div className="flex-1">
          {/* Requirement link (if exists) */}
          {selectedSpec.requirement && (
            <span className="text-xs text-muted-foreground mb-1 block">
              {selectedSpec.requirement}
            </span>
          )}

          {/* Scenario name */}
          <h3 className="text-lg font-semibold text-foreground">
            {selectedSpec.scenario}
          </h3>
        </div>
      </div>

      {/* Given/When/Then sections */}
      <div className="space-y-4">
        {/* Given section */}
        {hasGiven && (
          <div>
            <span className={cn(
              "text-xs font-semibold uppercase tracking-wider",
              phaseColors.text
            )}>
              Given
            </span>
            <div className="mt-1">
              <PropertyRenderer
                property={givenPropertyMeta}
                value={selectedSpec.given}
                config={compactConfig}
              />
            </div>
          </div>
        )}

        {/* When section */}
        {hasWhen && (
          <div>
            <span className={cn(
              "text-xs font-semibold uppercase tracking-wider",
              phaseColors.text
            )}>
              When
            </span>
            <div className="pl-4 text-sm text-foreground mt-1">
              {selectedSpec.when[0]}
            </div>
          </div>
        )}

        {/* Then section */}
        {hasThen && (
          <div>
            <span className={cn(
              "text-xs font-semibold uppercase tracking-wider",
              phaseColors.text
            )}>
              Then
            </span>
            <div className="mt-1">
              <PropertyRenderer
                property={thenPropertyMeta}
                value={selectedSpec.then}
                config={compactConfig}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default ScenarioSpotlightSection

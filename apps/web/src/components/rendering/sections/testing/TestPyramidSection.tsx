/**
 * TestPyramidSection
 * Task: task-testing-002
 *
 * Displays SVG test pyramid visualization with unit/integration/acceptance tiers.
 * Part of the composable Testing phase view.
 *
 * Features:
 * - Fetches tasks and specs from platformFeatures domain using feature.id
 * - Computes distribution counts: unitCount, integrationCount, acceptanceCount
 * - Renders SVG viewBox='0 0 200 160' with three polygon tiers
 * - Unit tier (bottom): cyan-500/20 fill
 * - Integration tier (middle): cyan-500/30 fill
 * - Acceptance tier (top): cyan-500/40 fill
 * - Text labels inside each tier showing type name and count
 * - Percentages overlay at bottom showing distribution ratios
 * - Card wrapper with phase-colored border
 * - Header with CheckCircle2 icon and 'Test Pyramid' title
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { SectionRendererProps } from "../../types"

/**
 * TestPyramidSection - SVG test pyramid visualization
 *
 * Renders an SVG pyramid showing the distribution of test types:
 * - Unit tests (bottom, largest tier)
 * - Integration tests (middle tier)
 * - Acceptance tests (top, smallest tier)
 */
export const TestPyramidSection = observer(function TestPyramidSection({
  feature,
  config,
}: SectionRendererProps) {
  // Phase colors for testing (cyan)
  const phaseColors = usePhaseColor("testing")

  // Access platform-features domain for tasks and specs
  const { platformFeatures } = useDomains()

  // Fetch tasks for this feature session
  const tasks = useMemo(() => {
    return platformFeatures?.implementationTaskCollection?.findBySession?.(feature?.id) ?? []
  }, [platformFeatures?.implementationTaskCollection, feature?.id])

  // Gather all test specs from all tasks
  const allSpecs = useMemo(() => {
    return tasks.flatMap((task: any) => {
      return platformFeatures?.testSpecificationCollection?.findByTask?.(task.id) ?? []
    })
  }, [tasks, platformFeatures?.testSpecificationCollection])

  // Compute distribution counts
  const { unitCount, integrationCount, acceptanceCount } = useMemo(() => {
    let unit = 0
    let integration = 0
    let acceptance = 0

    allSpecs.forEach((spec: any) => {
      const testType = (spec.testType || "unit").toLowerCase()
      if (testType === "unit") {
        unit++
      } else if (testType === "integration") {
        integration++
      } else if (testType === "acceptance" || testType === "e2e") {
        acceptance++
      } else {
        unit++ // Default to unit
      }
    })

    return {
      unitCount: unit,
      integrationCount: integration,
      acceptanceCount: acceptance,
    }
  }, [allSpecs])

  // Calculate percentages
  const total = unitCount + integrationCount + acceptanceCount
  const unitPercent = total > 0 ? (unitCount / total) * 100 : 33
  const integrationPercent = total > 0 ? (integrationCount / total) * 100 : 33
  const acceptancePercent = total > 0 ? (acceptanceCount / total) * 100 : 34

  return (
    <section
      data-testid="test-pyramid-section"
      className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <CheckCircle2 className={cn("h-5 w-5", phaseColors.text)} />
        <h3 className={cn("text-lg font-semibold", phaseColors.text)}>
          Test Pyramid
        </h3>
      </div>

      {/* SVG Pyramid */}
      <div className="relative w-full max-w-[280px] mx-auto">
        <svg viewBox="0 0 200 160" className="w-full h-auto">
          {/* Unit tier (bottom, largest) */}
          <polygon
            points="20,140 180,140 150,100 50,100"
            className="fill-cyan-500/20 stroke-cyan-500"
            strokeWidth="2"
          />
          <text
            x="100"
            y="125"
            textAnchor="middle"
            className="fill-cyan-400 text-xs font-medium"
          >
            Unit ({unitCount})
          </text>

          {/* Integration tier (middle) */}
          <polygon
            points="50,100 150,100 130,60 70,60"
            className="fill-cyan-500/30 stroke-cyan-500"
            strokeWidth="2"
          />
          <text
            x="100"
            y="85"
            textAnchor="middle"
            className="fill-cyan-400 text-xs font-medium"
          >
            Integration ({integrationCount})
          </text>

          {/* Acceptance tier (top, smallest) */}
          <polygon
            points="70,60 130,60 115,30 85,30"
            className="fill-cyan-500/40 stroke-cyan-500"
            strokeWidth="2"
          />
          <text
            x="100"
            y="50"
            textAnchor="middle"
            className="fill-cyan-300 text-xs font-medium"
          >
            Acceptance ({acceptanceCount})
          </text>
        </svg>

        {/* Percentages overlay at bottom */}
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-4 text-xs text-muted-foreground">
          <span>{unitPercent.toFixed(0)}%</span>
          <span>{integrationPercent.toFixed(0)}%</span>
          <span>{acceptancePercent.toFixed(0)}%</span>
        </div>
      </div>
    </section>
  )
})

export default TestPyramidSection

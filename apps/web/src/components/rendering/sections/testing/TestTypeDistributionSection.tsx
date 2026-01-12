/**
 * TestTypeDistributionSection
 * Task: task-testing-003
 *
 * Displays test type distribution breakdown with counts, percentages, and ProgressBar visualization.
 * Part of the composable Testing phase view.
 *
 * Features:
 * - Fetches tasks and specs from platformFeatures domain using feature.id
 * - Computes distribution array with type, label, count, color for each test type
 * - Renders Layers icon with 'Test Type Distribution' title
 * - ProgressBar primitive for each test type with count and percentage
 * - Handles empty state gracefully when no specs exist
 * - Uses usePhaseColor('testing') for cyan theme tokens
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { Layers } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ProgressBar } from "@/components/rendering/displays/visualization/ProgressBar"
import {
  SectionCard,
  SectionHeader,
  EmptySectionState,
} from "../shared"
import type { SectionRendererProps } from "../../types"

/**
 * Distribution item for a test type
 */
interface DistributionItem {
  type: "unit" | "integration" | "acceptance"
  label: string
  count: number
  color: string
}

/**
 * Test type colors (hex values for ProgressBar)
 */
const TEST_TYPE_COLORS: Record<string, string> = {
  unit: "#06b6d4",        // cyan-500
  integration: "#10b981", // emerald-500
  acceptance: "#22c55e",  // green-500
}

/**
 * Human-readable labels for test types
 */
const TEST_TYPE_LABELS: Record<string, string> = {
  unit: "Unit",
  integration: "Integration",
  acceptance: "Acceptance",
}

/**
 * TestTypeDistributionSection - Test type breakdown with progress bars
 *
 * Shows distribution of test specifications by type (unit, integration, acceptance)
 * with visual ProgressBar representation and count/percentage statistics.
 */
export const TestTypeDistributionSection = observer(function TestTypeDistributionSection({
  feature,
  config,
}: SectionRendererProps) {
  // Get testing phase colors (cyan theme)
  const phaseColors = usePhaseColor("testing")

  // Access platform-features domain for tasks and specs
  const { platformFeatures } = useDomains()

  // Get tasks for this feature session
  const tasks = useMemo(() => {
    if (!platformFeatures?.implementationTaskCollection) return []
    return platformFeatures.implementationTaskCollection
      .all()
      .filter((t: any) => t.session?.id === feature?.id)
  }, [platformFeatures, feature?.id])

  // Get task IDs for filtering specs
  const taskIds = useMemo(() => new Set(tasks.map((t: any) => t.id)), [tasks])

  // Get specs for tasks belonging to this feature
  const specs = useMemo(() => {
    if (!platformFeatures?.testSpecificationCollection) return []
    return platformFeatures.testSpecificationCollection
      .all()
      .filter((s: any) => taskIds.has(s.task?.id))
  }, [platformFeatures, taskIds])

  // Compute distribution array
  const distribution = useMemo((): DistributionItem[] => {
    const counts: Record<string, number> = {
      unit: 0,
      integration: 0,
      acceptance: 0,
    }

    specs.forEach((spec: any) => {
      if (spec.testType && spec.testType in counts) {
        counts[spec.testType]++
      }
    })

    return [
      { type: "unit", label: TEST_TYPE_LABELS.unit, count: counts.unit, color: TEST_TYPE_COLORS.unit },
      { type: "integration", label: TEST_TYPE_LABELS.integration, count: counts.integration, color: TEST_TYPE_COLORS.integration },
      { type: "acceptance", label: TEST_TYPE_LABELS.acceptance, count: counts.acceptance, color: TEST_TYPE_COLORS.acceptance },
    ]
  }, [specs])

  // Calculate total for percentage
  const total = useMemo(() => {
    return distribution.reduce((sum, item) => sum + item.count, 0)
  }, [distribution])

  // Calculate percentage for an item
  const getPercentage = (count: number): number => {
    if (total === 0) return 0
    return Math.round((count / total) * 100)
  }

  return (
    <SectionCard
      phaseColors={phaseColors}
      testId="test-type-distribution-section"
    >
      <SectionHeader
        icon={<Layers className="h-4 w-4" />}
        title="Test Type Distribution"
        phaseColors={phaseColors}
      />

      <div className="mt-4 space-y-3">
        {total === 0 ? (
          <EmptySectionState
            icon={Layers}
            message="No test specifications found"
          />
        ) : (
          distribution.map((item) => {
            const percentage = getPercentage(item.count)
            return (
              <div key={item.type} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground">
                    {item.count} ({percentage}%)
                  </span>
                </div>
                <ProgressBar
                  value={percentage}
                  max={100}
                  variant="horizontal"
                  className="h-2"
                  ariaLabel={`${item.label} tests: ${item.count} (${percentage}%)`}
                />
              </div>
            )
          })
        )}
      </div>
    </SectionCard>
  )
})

export default TestTypeDistributionSection

/**
 * TestingView Component - Redesigned
 * Task: task-w2-testing-view-redesign
 *
 * "Test Coverage Matrix + Pyramid" aesthetic with:
 * - TestPyramid: SVG visualization showing unit/integration/acceptance distribution
 * - TestTypeDistributionCard: Breakdown with counts and percentages using ProgressBar
 * - TaskCoverageBar: Per-task test coverage visualization
 * - ScenarioSpotlightCard: Selected spec in large format with Given/When/Then
 *
 * Uses phase-testing color tokens (cyan) throughout.
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { FlaskConical, CheckCircle2, Layers, Target, X } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ProgressBar } from "../../primitives"
import { type TestSpec } from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

/**
 * Feature type for TestingView
 */
export interface TestingFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for TestingView component
 */
export interface TestingViewProps {
  /** Feature session to display */
  feature: TestingFeature
}

/**
 * Task type with test specs
 */
interface TaskWithSpecs {
  id: string
  name: string
  specs: TestSpec[]
}

/**
 * Test type distribution
 */
interface TestTypeCount {
  type: string
  label: string
  count: number
  color: string
}

/**
 * TestPyramid Component
 * SVG visualization showing the classic test pyramid with tiers for
 * unit (base), integration (middle), and acceptance (top) tests.
 */
function TestPyramid({
  unitCount,
  integrationCount,
  acceptanceCount,
  phaseColors,
}: {
  unitCount: number
  integrationCount: number
  acceptanceCount: number
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  const total = unitCount + integrationCount + acceptanceCount
  const unitPercent = total > 0 ? (unitCount / total) * 100 : 33
  const integrationPercent = total > 0 ? (integrationCount / total) * 100 : 33
  const acceptancePercent = total > 0 ? (acceptanceCount / total) * 100 : 34

  return (
    <div className="relative w-full max-w-[280px] mx-auto">
      <svg viewBox="0 0 200 160" className="w-full h-auto">
        {/* Pyramid tiers - bottom to top */}
        {/* Unit tier (bottom, largest) */}
        <polygon
          points="20,140 180,140 150,100 50,100"
          className="fill-cyan-500/20 stroke-cyan-500"
          strokeWidth="2"
        />
        <text x="100" y="125" textAnchor="middle" className="fill-cyan-400 text-xs font-medium">
          Unit ({unitCount})
        </text>

        {/* Integration tier (middle) */}
        <polygon
          points="50,100 150,100 130,60 70,60"
          className="fill-cyan-500/30 stroke-cyan-500"
          strokeWidth="2"
        />
        <text x="100" y="85" textAnchor="middle" className="fill-cyan-400 text-xs font-medium">
          Integration ({integrationCount})
        </text>

        {/* Acceptance tier (top, smallest) */}
        <polygon
          points="70,60 130,60 115,30 85,30"
          className="fill-cyan-500/40 stroke-cyan-500"
          strokeWidth="2"
        />
        <text x="100" y="50" textAnchor="middle" className="fill-cyan-300 text-xs font-medium">
          E2E ({acceptanceCount})
        </text>
      </svg>

      {/* Percentages overlay */}
      <div className="absolute bottom-0 left-0 right-0 flex justify-between px-4 text-xs text-muted-foreground">
        <span>{unitPercent.toFixed(0)}%</span>
        <span>{integrationPercent.toFixed(0)}%</span>
        <span>{acceptancePercent.toFixed(0)}%</span>
      </div>
    </div>
  )
}

/**
 * TestTypeDistributionCard Component
 * Shows breakdown of tests by type with counts, percentages, and progress bars.
 */
function TestTypeDistributionCard({
  distribution,
  total,
  phaseColors,
}: {
  distribution: TestTypeCount[]
  total: number
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <Layers className="h-4 w-4" />
        Test Type Distribution
      </h4>
      <div className="space-y-3">
        {distribution.map((item) => {
          const percent = total > 0 ? (item.count / total) * 100 : 0
          return (
            <div key={item.type} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground">{item.label}</span>
                <span className="text-muted-foreground">
                  {item.count} ({percent.toFixed(0)}%)
                </span>
              </div>
              <ProgressBar
                value={percent}
                max={100}
                className="h-2"
                variant="default"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * TaskCoverageBar Component
 * Shows test coverage for each task with progress bar visualization.
 */
function TaskCoverageBar({
  tasksWithSpecs,
  maxSpecs,
  phaseColors,
  onSelectSpec,
}: {
  tasksWithSpecs: TaskWithSpecs[]
  maxSpecs: number
  phaseColors: ReturnType<typeof usePhaseColor>
  onSelectSpec: (spec: TestSpec) => void
}) {
  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <Target className="h-4 w-4" />
        Task Coverage
      </h4>
      <div className="space-y-3">
        {tasksWithSpecs.map((task) => {
          const coverage = maxSpecs > 0 ? (task.specs.length / maxSpecs) * 100 : 0
          return (
            <div key={task.id} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground truncate max-w-[200px]" title={task.name}>
                  {task.name}
                </span>
                <span className="text-muted-foreground flex-shrink-0">
                  {task.specs.length} spec{task.specs.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <ProgressBar
                  value={coverage}
                  max={100}
                  className="h-2 flex-1"
                  variant="default"
                />
                {/* Clickable dots for each spec */}
                <div className="flex gap-0.5">
                  {task.specs.slice(0, 5).map((spec) => (
                    <button
                      key={spec.id}
                      onClick={() => onSelectSpec(spec)}
                      className="w-2 h-2 rounded-full bg-cyan-500 hover:bg-cyan-400 transition-colors"
                      title={spec.scenario}
                    />
                  ))}
                  {task.specs.length > 5 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      +{task.specs.length - 5}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * ScenarioSpotlightCard Component
 * Large-format display of selected test spec with Given/When/Then sections.
 */
function ScenarioSpotlightCard({
  spec,
  onClose,
  phaseColors,
}: {
  spec: TestSpec
  onClose: () => void
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  return (
    <div className={cn("p-5 rounded-lg border-2 bg-card", "border-cyan-500/50")}>
      {/* Header with test type badge */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn(
              "px-2 py-0.5 rounded text-xs font-medium",
              "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
            )}>
              {spec.testType || "unit"}
            </span>
            {spec.requirement && (
              <span className="text-xs text-muted-foreground">
                req: {spec.requirement}
              </span>
            )}
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            {spec.scenario}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Given/When/Then sections */}
      <div className="space-y-4">
        {/* Given */}
        {spec.given && spec.given.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs font-semibold text-cyan-500 uppercase tracking-wider">
              Given
            </span>
            <ul className="space-y-1 pl-4">
              {spec.given.map((item: string, i: number) => (
                <li key={i} className="text-sm text-foreground list-disc">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* When */}
        {spec.when && (
          <div className="space-y-1">
            <span className="text-xs font-semibold text-cyan-500 uppercase tracking-wider">
              When
            </span>
            <p className="text-sm text-foreground pl-4">{spec.when}</p>
          </div>
        )}

        {/* Then */}
        {spec.then && spec.then.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs font-semibold text-cyan-500 uppercase tracking-wider">
              Then
            </span>
            <ul className="space-y-1 pl-4">
              {spec.then.map((item: string, i: number) => (
                <li key={i} className="text-sm text-foreground list-disc">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * TestingView Component
 *
 * Displays the Testing phase with "Test Coverage Matrix + Pyramid" aesthetic:
 * 1. TestPyramid - SVG showing unit/integration/acceptance distribution
 * 2. TestTypeDistributionCard - Breakdown with percentages and progress bars
 * 3. TaskCoverageBar - Per-task test coverage visualization
 * 4. ScenarioSpotlightCard - Selected spec in large format
 */
export const TestingView = observer(function TestingView({
  feature,
}: TestingViewProps) {
  // Phase colors for testing (cyan)
  const phaseColors = usePhaseColor("testing")

  // Selected spec for spotlight
  const [selectedSpec, setSelectedSpec] = useState<TestSpec | null>(null)

  // Access platform-features domain for tasks and specs
  const { platformFeatures } = useDomains()

  // Fetch tasks for this feature session
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []

  // Build task-to-specs mapping
  const tasksWithSpecs: TaskWithSpecs[] = useMemo(() => {
    return tasks.map((task: any) => ({
      id: task.id,
      name: task.name,
      specs: platformFeatures?.testSpecificationCollection?.findByTask?.(task.id) ?? [],
    })).filter((t: TaskWithSpecs) => t.specs.length > 0)
  }, [tasks, platformFeatures])

  // Gather all specs and calculate distribution
  const allSpecs = useMemo(() => {
    return tasksWithSpecs.flatMap((t) => t.specs)
  }, [tasksWithSpecs])

  const totalSpecs = allSpecs.length

  // Calculate test type distribution
  const distribution = useMemo((): TestTypeCount[] => {
    const counts: Record<string, number> = {
      unit: 0,
      integration: 0,
      acceptance: 0,
    }

    allSpecs.forEach((spec) => {
      const testType = (spec.testType || "unit").toLowerCase()
      if (testType.includes("unit")) {
        counts.unit++
      } else if (testType.includes("integration")) {
        counts.integration++
      } else if (testType.includes("acceptance") || testType.includes("e2e")) {
        counts.acceptance++
      } else {
        counts.unit++ // Default to unit
      }
    })

    return [
      { type: "unit", label: "Unit Tests", count: counts.unit, color: "cyan" },
      { type: "integration", label: "Integration Tests", count: counts.integration, color: "cyan" },
      { type: "acceptance", label: "Acceptance / E2E", count: counts.acceptance, color: "cyan" },
    ]
  }, [allSpecs])

  // Max specs per task for coverage bar scaling
  const maxSpecs = useMemo(() => {
    return Math.max(...tasksWithSpecs.map((t) => t.specs.length), 1)
  }, [tasksWithSpecs])

  // Handle spec selection
  const handleSelectSpec = (spec: TestSpec) => {
    setSelectedSpec(spec)
  }

  const handleCloseSpotlight = () => {
    setSelectedSpec(null)
  }

  return (
    <div data-testid="testing-view" className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className={cn("flex items-center gap-2 pb-3 mb-3 border-b min-w-0", phaseColors.border)}>
        <FlaskConical className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Test Coverage Matrix
        </h2>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          ({totalSpecs} specification{totalSpecs !== 1 ? "s" : ""})
        </span>
      </div>

      {/* Content */}
      {totalSpecs === 0 ? (
        <EmptyPhaseContent
          phaseName="testing"
          message="No test specifications generated"
          description="Run the Testing phase to generate test specifications from implementation tasks."
        />
      ) : (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
          {/* Left column: Pyramid + Distribution */}
          <div className="space-y-4">
            {/* Test Pyramid */}
            <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
              <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
                <CheckCircle2 className="h-4 w-4" />
                Test Pyramid
              </h4>
              <TestPyramid
                unitCount={distribution.find((d) => d.type === "unit")?.count || 0}
                integrationCount={distribution.find((d) => d.type === "integration")?.count || 0}
                acceptanceCount={distribution.find((d) => d.type === "acceptance")?.count || 0}
                phaseColors={phaseColors}
              />
            </div>

            {/* Test Type Distribution */}
            <TestTypeDistributionCard
              distribution={distribution}
              total={totalSpecs}
              phaseColors={phaseColors}
            />
          </div>

          {/* Right column: Coverage + Spotlight */}
          <div className="space-y-4">
            {/* Task Coverage Bar */}
            <TaskCoverageBar
              tasksWithSpecs={tasksWithSpecs}
              maxSpecs={maxSpecs}
              phaseColors={phaseColors}
              onSelectSpec={handleSelectSpec}
            />

            {/* Scenario Spotlight (if selected) */}
            {selectedSpec && (
              <ScenarioSpotlightCard
                spec={selectedSpec}
                onClose={handleCloseSpotlight}
                phaseColors={phaseColors}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
})

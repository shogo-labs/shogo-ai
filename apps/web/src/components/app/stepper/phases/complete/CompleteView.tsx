/**
 * CompleteView Component - Redesigned
 * Task: task-w2-complete-view-redesign
 *
 * "Journey Summary Report" aesthetic with:
 * - PhaseTimeline: Shows progression through phases with checkmarks
 * - DeliverablesGrid: Displays key outputs (schema, tasks, specs)
 * - SuccessBanner: Achievement-style celebration banner
 * - StatisticsRecap: Final counts and metrics
 *
 * Uses phase-complete color tokens (green) throughout.
 */

import { useMemo } from "react"
import { observer } from "mobx-react-lite"
import {
  CheckCircle,
  FileText,
  TestTube,
  PlayCircle,
  AlertCircle,
  Trophy,
  FileCode,
  ListChecks,
  Clock,
} from "lucide-react"
import { useDomains } from "@shogo/app-core"
import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"

/**
 * Feature type for CompleteView
 */
export interface CompleteFeature {
  id: string
  name: string
  status: string
  updatedAt?: number
  createdAt?: number
}

/**
 * Props for CompleteView component
 */
export interface CompleteViewProps {
  /** Feature session to display */
  feature: CompleteFeature
}

/**
 * Phase configuration for timeline
 */
interface PhaseConfig {
  name: string
  key: string
  icon: React.ElementType
  color: string
}

const PHASES: PhaseConfig[] = [
  { name: "Discovery", key: "discovery", icon: FileText, color: "text-blue-500" },
  { name: "Analysis", key: "analysis", icon: FileText, color: "text-violet-500" },
  { name: "Classification", key: "classification", icon: FileText, color: "text-pink-500" },
  { name: "Design", key: "design", icon: FileCode, color: "text-amber-500" },
  { name: "Spec", key: "spec", icon: ListChecks, color: "text-emerald-500" },
  { name: "Testing", key: "testing", icon: TestTube, color: "text-cyan-500" },
  { name: "Implementation", key: "implementation", icon: PlayCircle, color: "text-red-500" },
  { name: "Complete", key: "complete", icon: CheckCircle, color: "text-green-500" },
]

/**
 * Format timestamp to readable date
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Format duration from milliseconds
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * PhaseTimeline Component
 * Shows progression through phases with checkmarks.
 */
function PhaseTimeline({ phaseColors }: { phaseColors: ReturnType<typeof usePhaseColor> }) {
  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-4 flex items-center gap-2", phaseColors.text)}>
        <Clock className="h-4 w-4" />
        Journey Timeline
      </h4>
      <div className="flex items-center justify-between overflow-x-auto pb-2">
        {PHASES.map((phase, index) => {
          const Icon = phase.icon
          return (
            <div key={phase.key} className="flex items-center">
              <div className="flex flex-col items-center min-w-[80px]">
                <div
                  className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center",
                    "bg-green-500/20 border-2 border-green-500"
                  )}
                >
                  <CheckCircle className="h-4 w-4 text-green-500" />
                </div>
                <span className="text-xs text-muted-foreground mt-1 text-center">
                  {phase.name}
                </span>
              </div>
              {index < PHASES.length - 1 && (
                <div className="w-4 h-0.5 bg-green-500 mx-1" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * SuccessBanner Component
 * Achievement-style celebration banner.
 */
function SuccessBanner({
  featureName,
  completedAt,
  duration,
  phaseColors,
}: {
  featureName: string
  completedAt?: number
  duration?: number
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center p-8 rounded-lg",
        "bg-gradient-to-b from-green-500/20 to-emerald-500/10",
        "border-2 border-green-500/50"
      )}
    >
      <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
        <Trophy className="h-8 w-8 text-green-500" />
      </div>
      <h2 className="text-3xl font-bold text-green-500 mb-2">
        Feature Complete!
      </h2>
      <p className="text-lg text-foreground mb-2 break-words">
        Congratulations! "{featureName}" has been successfully implemented.
      </p>
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        {completedAt && (
          <span>Completed on {formatDate(completedAt)}</span>
        )}
        {duration && (
          <>
            <span className="text-green-500/50">|</span>
            <span>Total time: {formatDuration(duration)}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Deliverable item configuration
 */
interface DeliverableItem {
  label: string
  value: string | number
  icon: React.ElementType
  color: string
}

/**
 * DeliverablesGrid Component
 * Displays key outputs from the feature.
 */
function DeliverablesGrid({
  deliverables,
  phaseColors,
}: {
  deliverables: DeliverableItem[]
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <FileCode className="h-4 w-4" />
        Deliverables
      </h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {deliverables.map((item, index) => {
          const Icon = item.icon
          return (
            <div
              key={index}
              className="p-3 rounded-lg border border-green-500/20 bg-green-500/5"
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className={cn("h-4 w-4", item.color)} />
                <span className="text-xs text-muted-foreground">{item.label}</span>
              </div>
              <div className="text-lg font-bold text-foreground">{item.value}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * StatisticsRecap Component
 * Final counts and metrics summary.
 */
function StatisticsRecap({
  totalTasks,
  completedTasks,
  totalSpecs,
  totalRuns,
  phaseColors,
}: {
  totalTasks: number
  completedTasks: number
  totalSpecs: number
  totalRuns: number
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  const stats = [
    {
      label: "Tasks Completed",
      value: completedTasks,
      total: totalTasks,
      icon: ListChecks,
      color: "text-emerald-500",
    },
    {
      label: "Test Specs",
      value: totalSpecs,
      icon: TestTube,
      color: "text-cyan-500",
    },
    {
      label: "Implementation Runs",
      value: totalRuns,
      icon: PlayCircle,
      color: "text-green-500",
    },
  ]

  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <Trophy className="h-4 w-4" />
        Summary Statistics
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((stat, index) => {
          const Icon = stat.icon
          return (
            <div
              key={index}
              className="flex items-center gap-3 p-3 rounded-lg bg-muted/30"
            >
              <div className={cn("p-2 rounded-lg bg-green-500/10", stat.color)}>
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">
                  {stat.value}
                  {stat.total !== undefined && (
                    <span className="text-sm font-normal text-muted-foreground">
                      /{stat.total}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * CompleteView Component
 *
 * Displays the Complete phase with "Journey Summary Report" aesthetic:
 * 1. SuccessBanner - Achievement-style celebration
 * 2. PhaseTimeline - Progression through all phases
 * 3. StatisticsRecap - Final counts and metrics
 * 4. DeliverablesGrid - Key outputs from the feature
 */
export const CompleteView = observer(function CompleteView({
  feature,
}: CompleteViewProps) {
  // Phase colors for complete (green)
  const phaseColors = usePhaseColor("complete")

  // Access platform-features domain for stats
  const { platformFeatures } = useDomains()

  // Check if feature is complete
  const isComplete = feature.status === "complete"

  // If not complete, show message
  if (!isComplete) {
    return (
      <div
        data-testid="complete-view"
        className="flex flex-col items-center justify-center p-8 text-center"
      >
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold text-foreground mb-2">
          Feature Not Yet Complete
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          This feature is still in progress. Complete the implementation phase to see the summary.
        </p>
      </div>
    )
  }

  // Fetch stats
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []
  const completedTasks = tasks.filter((t: any) => t.status === "complete")
  const allSpecs = platformFeatures?.testSpecificationCollection?.all?.() ?? []
  const specs = allSpecs.filter((s: any) => {
    return tasks.some((t: any) => t.id === (typeof s.task === "string" ? s.task : s.task?.id))
  })
  const runs = platformFeatures?.implementationRunCollection?.findBySession?.(feature.id) ?? []

  // Calculate duration if we have timestamps
  const duration = useMemo(() => {
    if (feature.createdAt && feature.updatedAt) {
      return feature.updatedAt - feature.createdAt
    }
    return undefined
  }, [feature.createdAt, feature.updatedAt])

  // Build deliverables list
  const deliverables: DeliverableItem[] = useMemo(() => [
    { label: "Schema", value: 1, icon: FileCode, color: "text-amber-500" },
    { label: "Tasks", value: tasks.length, icon: ListChecks, color: "text-emerald-500" },
    { label: "Test Specs", value: specs.length, icon: TestTube, color: "text-cyan-500" },
    { label: "Impl Runs", value: runs.length, icon: PlayCircle, color: "text-green-500" },
  ], [tasks.length, specs.length, runs.length])

  return (
    <div data-testid="complete-view" className="h-full flex flex-col space-y-4 overflow-hidden">
      {/* Success Banner */}
      <SuccessBanner
        featureName={feature.name}
        completedAt={feature.updatedAt}
        duration={duration}
        phaseColors={phaseColors}
      />

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
        {/* Left column: Timeline */}
        <PhaseTimeline phaseColors={phaseColors} />

        {/* Right column: Deliverables */}
        <DeliverablesGrid deliverables={deliverables} phaseColors={phaseColors} />
      </div>

      {/* Statistics Recap */}
      <StatisticsRecap
        totalTasks={tasks.length}
        completedTasks={completedTasks.length}
        totalSpecs={specs.length}
        totalRuns={runs.length}
        phaseColors={phaseColors}
      />
    </div>
  )
})

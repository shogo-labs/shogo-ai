/**
 * ImplementationView Component - Redesigned
 * Task: task-w2-implementation-view-redesign
 *
 * "Execution Control Room" aesthetic with:
 * - TDDStageIndicator: Shows current RED/GREEN/REFACTOR stage
 * - TaskExecutionTimeline: List of executions with status
 * - LiveOutputTerminal: Selected execution's test output
 * - ProgressDashboard: Overall completion stats
 *
 * Uses phase-implementation color tokens (red for failing, green for passing).
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import {
  Play,
  CheckCircle,
  XCircle,
  Clock,
  Terminal,
  Zap,
  ChevronRight,
} from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { ProgressBar } from "../../primitives"
import { type TaskExecution } from "../../cards"
import { EmptyPhaseContent } from "../../EmptyStates"

/**
 * Feature type for ImplementationView
 */
export interface ImplementationFeature {
  id: string
  name: string
  status: string
}

/**
 * Props for ImplementationView component
 */
export interface ImplementationViewProps {
  /** Feature session to display */
  feature: ImplementationFeature
}

/**
 * TDD Stage type
 */
type TDDStage = "idle" | "pending" | "test_failing" | "test_passing" | "complete" | "failed"

/**
 * Stage configuration for TDD indicator
 */
const stageConfig: Record<TDDStage, {
  label: string
  icon: React.ElementType
  bgColor: string
  textColor: string
  borderColor: string
}> = {
  idle: {
    label: "IDLE",
    icon: Clock,
    bgColor: "bg-muted/30",
    textColor: "text-muted-foreground",
    borderColor: "border-muted",
  },
  pending: {
    label: "PENDING",
    icon: Clock,
    bgColor: "bg-amber-500/10",
    textColor: "text-amber-500",
    borderColor: "border-amber-500/30",
  },
  test_failing: {
    label: "RED",
    icon: XCircle,
    bgColor: "bg-red-500/10",
    textColor: "text-red-500",
    borderColor: "border-red-500/30",
  },
  test_passing: {
    label: "GREEN",
    icon: CheckCircle,
    bgColor: "bg-green-500/10",
    textColor: "text-green-500",
    borderColor: "border-green-500/30",
  },
  complete: {
    label: "COMPLETE",
    icon: CheckCircle,
    bgColor: "bg-emerald-500/10",
    textColor: "text-emerald-500",
    borderColor: "border-emerald-500/30",
  },
  failed: {
    label: "FAILED",
    icon: XCircle,
    bgColor: "bg-red-500/20",
    textColor: "text-red-400",
    borderColor: "border-red-500/50",
  },
}

/**
 * TDDStageIndicator Component
 * Shows the current TDD stage with visual distinction.
 */
function TDDStageIndicator({ stage }: { stage: TDDStage }) {
  const config = stageConfig[stage]
  const Icon = config.icon

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-lg border",
        config.bgColor,
        config.borderColor
      )}
    >
      <Icon className={cn("h-5 w-5", config.textColor)} />
      <span className={cn("font-bold text-sm tracking-wider", config.textColor)}>
        {config.label}
      </span>
    </div>
  )
}

/**
 * ProgressDashboard Component
 * Shows overall implementation progress with stats.
 */
function ProgressDashboard({
  totalTasks,
  completedTasks,
  failedTasks,
  inProgressTask,
  phaseColors,
}: {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  inProgressTask: string | null
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  const percentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0

  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <div className="flex items-center justify-between mb-3">
        <h4 className={cn("text-sm font-semibold flex items-center gap-2", phaseColors.text)}>
          <Zap className="h-4 w-4" />
          Execution Progress
        </h4>
        <span className="text-sm text-muted-foreground">
          {completedTasks}/{totalTasks} tasks
        </span>
      </div>

      <ProgressBar value={percentage} max={100} className="h-3 mb-3" variant="default" />

      <div className="grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-2xl font-bold text-emerald-500">{completedTasks}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-amber-500">
            {inProgressTask ? 1 : 0}
          </div>
          <div className="text-xs text-muted-foreground">In Progress</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-red-500">{failedTasks}</div>
          <div className="text-xs text-muted-foreground">Failed</div>
        </div>
      </div>

      {inProgressTask && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center gap-2 text-sm">
            <Play className="h-3 w-3 text-amber-500 animate-pulse" />
            <span className="text-muted-foreground">Current:</span>
            <span className="text-foreground font-medium truncate">{inProgressTask}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * TaskExecutionTimeline Component
 * Shows list of task executions with status indicators.
 */
function TaskExecutionTimeline({
  executions,
  selectedExecutionId,
  onSelect,
  getTaskName,
  phaseColors,
}: {
  executions: TaskExecution[]
  selectedExecutionId: string | null
  onSelect: (exec: TaskExecution) => void
  getTaskName: (exec: TaskExecution) => string
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case "test_passing":
      case "complete":
        return "bg-green-500"
      case "test_failing":
        return "bg-red-500"
      case "in_progress":
        return "bg-amber-500 animate-pulse"
      default:
        return "bg-muted-foreground"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "test_passing":
      case "complete":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "test_failing":
        return <XCircle className="h-4 w-4 text-red-500" />
      case "in_progress":
        return <Play className="h-4 w-4 text-amber-500" />
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />
    }
  }

  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
        <Play className="h-4 w-4" />
        Task Executions ({executions.length})
      </h4>
      <div className="space-y-1 max-h-[300px] overflow-auto">
        {executions.map((exec, index) => (
          <button
            key={exec.id}
            onClick={() => onSelect(exec)}
            className={cn(
              "w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors",
              selectedExecutionId === exec.id
                ? "bg-red-500/10 border border-red-500/30"
                : "hover:bg-muted/50"
            )}
          >
            {/* Timeline connector */}
            <div className="flex flex-col items-center">
              <div className={cn("w-2.5 h-2.5 rounded-full", getStatusColor(exec.status))} />
              {index < executions.length - 1 && (
                <div className="w-0.5 h-4 bg-border mt-1" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {getStatusIcon(exec.status)}
                <span className="text-sm font-medium text-foreground truncate">
                  {getTaskName(exec)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {exec.status.replace("_", " ")}
              </div>
            </div>

            <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * LiveOutputTerminal Component
 * Shows test output for selected execution.
 */
function LiveOutputTerminal({
  execution,
  taskName,
  phaseColors,
}: {
  execution: TaskExecution | null
  taskName: string
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  if (!execution) {
    return (
      <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
        <h4 className={cn("text-sm font-semibold mb-3 flex items-center gap-2", phaseColors.text)}>
          <Terminal className="h-4 w-4" />
          Output Terminal
        </h4>
        <div className="bg-black/80 rounded-md p-4 font-mono text-xs text-muted-foreground">
          Select an execution to view output...
        </div>
      </div>
    )
  }

  const hasOutput = execution.testOutput || execution.errorMessage

  return (
    <div className={cn("p-4 rounded-lg border bg-card", phaseColors.border)}>
      <div className="flex items-center justify-between mb-3">
        <h4 className={cn("text-sm font-semibold flex items-center gap-2", phaseColors.text)}>
          <Terminal className="h-4 w-4" />
          Output: {taskName}
        </h4>
        <TDDStageIndicator stage={execution.status as TDDStage} />
      </div>

      <div className="bg-black/80 rounded-md p-4 font-mono text-xs max-h-[250px] overflow-auto">
        {hasOutput ? (
          <pre className={cn(
            "whitespace-pre-wrap",
            execution.status === "test_failing" ? "text-red-400" : "text-green-400"
          )}>
            {execution.testOutput || execution.errorMessage}
          </pre>
        ) : (
          <span className="text-muted-foreground">No output available</span>
        )}
      </div>

      {/* File paths if available */}
      {(execution.testFilePath || execution.implementationFilePath) && (
        <div className="mt-3 space-y-1 text-xs">
          {execution.testFilePath && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-red-400">TEST:</span>
              <code className="truncate">{execution.testFilePath}</code>
            </div>
          )}
          {execution.implementationFilePath && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-green-400">IMPL:</span>
              <code className="truncate">{execution.implementationFilePath}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * ImplementationView Component
 *
 * Displays the Implementation phase with "Execution Control Room" aesthetic:
 * 1. TDDStageIndicator - Current RED/GREEN/REFACTOR stage
 * 2. ProgressDashboard - Overall stats and current task
 * 3. TaskExecutionTimeline - List of executions with status
 * 4. LiveOutputTerminal - Selected execution's output
 */
export const ImplementationView = observer(function ImplementationView({
  feature,
}: ImplementationViewProps) {
  // Phase colors for implementation (red/green)
  const phaseColors = usePhaseColor("implementation")

  // Selected execution for terminal view
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null)

  // Access platform-features domain
  const { platformFeatures } = useDomains()

  // Fetch tasks for count
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature.id) ?? []
  const totalTasks = tasks.length

  // Fetch latest run for this session
  const latestRun = platformFeatures?.implementationRunCollection?.findLatestBySession?.(feature.id)

  // Fetch executions for the run
  const executions = useMemo(() => {
    if (!latestRun) return []
    return platformFeatures?.taskExecutionCollection?.findByRun?.(latestRun.id) ?? []
  }, [latestRun, platformFeatures])

  // Sort executions by startedAt (most recent first)
  const sortedExecutions = useMemo(() => {
    return [...executions].sort((a, b) => b.startedAt - a.startedAt)
  }, [executions])

  // Calculate completion stats
  const completedTasks = useMemo(() => {
    return executions.filter((e) => e.status === "test_passing" || e.status === "complete").length
  }, [executions])

  const failedTasks = useMemo(() => {
    return executions.filter((e) => e.status === "failed").length
  }, [executions])

  // Get current task name if run is in progress
  const currentTaskName = latestRun?.currentTaskId
    ? platformFeatures?.implementationTaskCollection?.get?.(latestRun.currentTaskId)?.name
    : null

  // Current TDD stage
  const currentStage: TDDStage = useMemo(() => {
    if (!latestRun) return "idle"
    if (latestRun.status === "complete") return "complete"
    if (latestRun.status === "failed") return "failed"

    // Check most recent execution for stage
    const latestExecution = sortedExecutions[0]
    if (!latestExecution) return "pending"

    return (latestExecution.status as TDDStage) || "pending"
  }, [latestRun, sortedExecutions])

  // Helper to get task name from execution
  const getTaskName = (execution: any): string => {
    if (execution.task?.name) return execution.task.name
    const taskId = typeof execution.task === "string" ? execution.task : execution.task?.id
    if (taskId) {
      const task = platformFeatures?.implementationTaskCollection?.get?.(taskId)
      return task?.name || "Unknown Task"
    }
    return "Unknown Task"
  }

  // Selected execution
  const selectedExecution = useMemo(() => {
    if (!selectedExecutionId) return sortedExecutions[0] || null
    return executions.find((e) => e.id === selectedExecutionId) || null
  }, [selectedExecutionId, executions, sortedExecutions])

  // Handle execution selection
  const handleSelectExecution = (exec: TaskExecution) => {
    setSelectedExecutionId(exec.id)
  }

  return (
    <div data-testid="implementation-view" className="h-full flex flex-col overflow-hidden">
      {/* Header with TDD Stage */}
      <div className={cn("flex items-center justify-between pb-3 mb-3 border-b min-w-0 gap-2", phaseColors.border)}>
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
          <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
            Execution Control Room
          </h2>
        </div>
        <TDDStageIndicator stage={currentStage} />
      </div>

      {/* Content */}
      {!latestRun ? (
        <EmptyPhaseContent
          phaseName="implementation"
          message="No implementation runs yet"
          description="Run the Implementation phase to start executing tasks."
        />
      ) : (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
          {/* Left column: Dashboard + Timeline */}
          <div className="space-y-4">
            <ProgressDashboard
              totalTasks={totalTasks}
              completedTasks={completedTasks}
              failedTasks={failedTasks}
              inProgressTask={currentTaskName}
              phaseColors={phaseColors}
            />

            {sortedExecutions.length > 0 && (
              <TaskExecutionTimeline
                executions={sortedExecutions}
                selectedExecutionId={selectedExecutionId}
                onSelect={handleSelectExecution}
                getTaskName={getTaskName}
                phaseColors={phaseColors}
              />
            )}
          </div>

          {/* Right column: Terminal */}
          <div className="space-y-4">
            <LiveOutputTerminal
              execution={selectedExecution}
              taskName={selectedExecution ? getTaskName(selectedExecution) : ""}
              phaseColors={phaseColors}
            />
          </div>
        </div>
      )}
    </div>
  )
})

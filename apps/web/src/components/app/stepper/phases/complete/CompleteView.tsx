/**
 * CompleteView Component
 * Task: task-2-3d-complete-view
 *
 * Displays the Complete phase content: summary when feature is done.
 *
 * Props:
 * - feature: FeatureForPanel with id, name, status, updatedAt
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/phases/complete/
 * - Uses useDomains() for data access
 * - Wrapped with observer() for MobX reactivity
 */

import { observer } from "mobx-react-lite"
import { CheckCircle, FileText, TestTube, PlayCircle, AlertCircle } from "lucide-react"
import { useDomains } from "@/contexts/DomainProvider"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * Feature type for CompleteView
 */
export interface CompleteFeature {
  id: string
  name: string
  status: string
  updatedAt?: number
}

/**
 * Props for CompleteView component
 */
export interface CompleteViewProps {
  /** Feature session to display */
  feature: CompleteFeature
}

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
 * Stat card configuration
 */
interface StatConfig {
  label: string
  icon: typeof FileText
  colorClass: string
}

const STAT_CONFIGS: Record<string, StatConfig> = {
  tasks: {
    label: "Tasks Completed",
    icon: FileText,
    colorClass: "text-blue-500",
  },
  specs: {
    label: "Test Specifications",
    icon: TestTube,
    colorClass: "text-purple-500",
  },
  runs: {
    label: "Implementation Runs",
    icon: PlayCircle,
    colorClass: "text-green-500",
  },
}

/**
 * CompleteView Component
 *
 * Displays completion summary with:
 * - Success icon and congratulatory message
 * - Completion timestamp
 * - Summary stats grid (tasks, specs, runs)
 */
export const CompleteView = observer(function CompleteView({
  feature,
}: CompleteViewProps) {
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
    // Find specs for tasks in this session
    return tasks.some((t: any) => t.id === (typeof s.task === "string" ? s.task : s.task?.id))
  })
  const runs = platformFeatures?.implementationRunCollection?.findBySession?.(feature.id) ?? []

  const stats = [
    { key: "tasks", value: completedTasks.length, total: tasks.length },
    { key: "specs", value: specs.length },
    { key: "runs", value: runs.length },
  ]

  return (
    <div data-testid="complete-view" className="space-y-6">
      {/* Success Header */}
      <div className="flex flex-col items-center text-center p-6 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
        <CheckCircle className="h-16 w-16 text-green-500 mb-4" />
        <h3 className="text-2xl font-bold text-green-700 dark:text-green-400 mb-2">
          Feature Complete!
        </h3>
        <p className="text-green-600 dark:text-green-500">
          Congratulations! The "{feature.name}" feature has been successfully implemented.
        </p>
        {feature.updatedAt && (
          <p className="text-sm text-green-600/70 dark:text-green-500/70 mt-2">
            Completed on {formatDate(feature.updatedAt)}
          </p>
        )}
      </div>

      {/* Stats Grid */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Summary Statistics
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {stats.map(({ key, value, total }) => {
            const config = STAT_CONFIGS[key]
            const Icon = config.icon

            return (
              <Card key={key} className="transition-all hover:shadow-md">
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className={cn("p-2 rounded-lg bg-muted", config.colorClass)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-foreground">
                        {value}
                        {total !== undefined && (
                          <span className="text-sm font-normal text-muted-foreground">
                            /{total}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {config.label}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>
    </div>
  )
})

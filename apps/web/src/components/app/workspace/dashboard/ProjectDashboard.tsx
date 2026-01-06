/**
 * ProjectDashboard Component
 * Task: task-2-2-007
 *
 * Dashboard shown when no feature is selected in WorkspaceLayout.
 * Displays project overview with stats cards and quick actions.
 *
 * Features:
 * - Project name as heading
 * - StatsCards grid showing feature counts by phase
 * - Create Feature quick action button
 *
 * Per design-2-2-component-hierarchy:
 * - This is a "presentational" component receiving data as props
 * - Does not call hooks directly - receives data from WorkspaceLayout
 *
 * CLEAN BREAK: Lives in /components/app/workspace/dashboard/, zero imports from /components/Studio/
 */

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { StatsCards } from "./StatsCards"

/**
 * Props for ProjectDashboard component
 */
export interface ProjectDashboardProps {
  /** The current project name to display as heading */
  projectName: string
  /** Features grouped by phase for stats display */
  featuresByPhase: Record<string, any[]>
  /** Callback when user clicks Create Feature button */
  onNewFeature: () => void
  /** Optional recent features list (deferred to Session 3.1) */
  recentFeatures?: any[]
  /** Optional className for the container */
  className?: string
}

/**
 * ProjectDashboard component
 *
 * Renders the project overview dashboard when no feature is selected.
 * Shows project name, stats cards grid, and quick action buttons.
 *
 * @example
 * ```tsx
 * <ProjectDashboard
 *   projectName="My Project"
 *   featuresByPhase={featuresByPhase}
 *   onNewFeature={() => setShowNewFeatureModal(true)}
 * />
 * ```
 */
export function ProjectDashboard({
  projectName,
  featuresByPhase,
  onNewFeature,
  recentFeatures,
  className,
}: ProjectDashboardProps) {
  return (
    <div
      data-testid="project-dashboard"
      className={cn("space-y-6", className)}
    >
      {/* Project name heading */}
      <div className="flex items-center justify-between">
        <h2
          data-testid="project-name"
          className="text-2xl font-bold tracking-tight"
        >
          {projectName}
        </h2>

        {/* Quick action button */}
        <Button
          data-testid="create-feature-button"
          onClick={onNewFeature}
          className="flex items-center gap-2"
        >
          <PlusIcon className="h-4 w-4" />
          Create Feature
        </Button>
      </div>

      {/* Stats cards grid */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-muted-foreground">
          Feature Overview
        </h3>
        <StatsCards featuresByPhase={featuresByPhase} />
      </div>

      {/* Recent features section (deferred to Session 3.1) */}
      {recentFeatures && recentFeatures.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-muted-foreground">
            Recent Features
          </h3>
          <div className="grid gap-2">
            {recentFeatures.slice(0, 5).map((feature: any) => (
              <div
                key={feature.id}
                className="p-3 bg-card rounded-lg border text-sm"
              >
                {feature.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Simple Plus icon component (avoiding external icon library dependency)
 */
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/**
 * StatsCards Component
 * Task: task-2-2-007
 *
 * Grid of stat cards showing feature counts by phase.
 * Uses shadcn Card component with responsive grid layout.
 *
 * Layout:
 * - grid-cols-2 for small screens (mobile)
 * - md:grid-cols-4 for medium+ screens (tablet/desktop)
 *
 * Phases displayed (8 total):
 * - Discovery, Analysis, Classification, Design
 * - Spec, Testing, Implementation, Complete
 *
 * CLEAN BREAK: Lives in /components/app/workspace/dashboard/, zero imports from /components/Studio/
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * All phases in the platform features workflow (8 phases)
 */
export const STAT_PHASES = [
  "discovery",
  "analysis",
  "classification",
  "design",
  "spec",
  "testing",
  "implementation",
  "complete",
] as const

export type StatPhase = (typeof STAT_PHASES)[number]

/**
 * Phase display configuration
 */
const PHASE_CONFIG: Record<StatPhase, { label: string; colorClass: string }> = {
  discovery: { label: "Discovery", colorClass: "text-blue-500" },
  analysis: { label: "Analysis", colorClass: "text-cyan-500" },
  classification: { label: "Classification", colorClass: "text-teal-500" },
  design: { label: "Design", colorClass: "text-purple-500" },
  spec: { label: "Spec", colorClass: "text-indigo-500" },
  testing: { label: "Testing", colorClass: "text-orange-500" },
  implementation: { label: "Implementation", colorClass: "text-amber-500" },
  complete: { label: "Complete", colorClass: "text-green-500" },
}

/**
 * Props for StatsCards component
 */
export interface StatsCardsProps {
  /** Features grouped by phase */
  featuresByPhase: Record<string, any[]>
  /** Optional className for the grid container */
  className?: string
}

/**
 * StatsCards component
 *
 * Renders a responsive grid of stat cards showing feature counts by phase.
 * Each card displays the phase name and count of features in that phase.
 *
 * @example
 * ```tsx
 * <StatsCards
 *   featuresByPhase={{
 *     discovery: [{ id: "f1" }, { id: "f2" }],
 *     design: [{ id: "f3" }],
 *     // ...other phases
 *   }}
 * />
 * ```
 */
export function StatsCards({ featuresByPhase, className }: StatsCardsProps) {
  return (
    <div
      data-testid="stats-cards"
      className={cn(
        "grid grid-cols-2 md:grid-cols-4 gap-4",
        className
      )}
    >
      {STAT_PHASES.map((phase) => {
        const config = PHASE_CONFIG[phase]
        const features = featuresByPhase[phase] || []
        const count = features.length

        return (
          <Card
            key={phase}
            data-testid={`stat-card-${phase}`}
            className={cn(
              "transition-all duration-200",
              "hover:shadow-md hover:border-primary/50",
              "cursor-default"
            )}
          >
            <CardHeader className="pb-2">
              <CardTitle className={cn("text-sm font-medium", config.colorClass)}>
                {config.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{count}</div>
              <p className="text-xs text-muted-foreground">
                {count === 1 ? "feature" : "features"}
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

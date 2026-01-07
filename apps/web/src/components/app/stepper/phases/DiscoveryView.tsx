/**
 * DiscoveryView Component - Redesigned
 * Task: task-w2-discovery-view-redesign
 *
 * "Mission Brief Command Center" aesthetic with:
 * - IntentTerminal: Monospace terminal-style intent display
 * - PriorityDistributionBar: Stacked bar showing must/should/could distribution
 * - Dual-column assessment: Indicators vs uncertainties with iconography
 *
 * Uses phase-discovery color tokens (blue) throughout.
 */

import { observer } from "mobx-react-lite"
import { useMemo } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { cn } from "@/lib/utils"
import { CheckCircle, HelpCircle, Terminal, FileText } from "lucide-react"
import { ProgressBar } from "@/components/rendering/displays/visualization/ProgressBar"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import {
  RequirementCard,
  ArchetypeBadge,
  type FeatureArchetype,
} from "../../shared"

/**
 * Extended feature type for DiscoveryView
 */
export interface DiscoveryFeature {
  id: string
  name: string
  status: string
  intent?: string
  initialAssessment?: {
    likelyArchetype?: FeatureArchetype
    indicators?: string[]
    uncertainties?: string[]
  }
}

/**
 * Props for DiscoveryView component
 */
export interface DiscoveryViewProps {
  /** Feature session to display */
  feature: DiscoveryFeature
}

/**
 * IntentTerminal Component
 * Terminal-style display for feature intent
 */
function IntentTerminal({ intent }: { intent?: string }) {
  const displayIntent = intent || "No intent specified"
  const charCount = displayIntent.length

  return (
    <div
      data-testid="intent-terminal"
      className="rounded-lg overflow-hidden border border-blue-500/30"
    >
      {/* Terminal header bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-700">
        <Terminal className="h-4 w-4 text-blue-400" />
        <span className="text-xs font-medium text-blue-400 uppercase tracking-wider">
          Mission Intent
        </span>
        <div className="flex-1" />
        <span className="text-xs text-zinc-500">{charCount} chars</span>
      </div>

      {/* Terminal content */}
      <div className="bg-zinc-900/95 p-4">
        <pre className="font-mono text-sm text-green-400 whitespace-pre-wrap leading-relaxed">
          <span className="text-blue-400">$ </span>
          {displayIntent}
          <span className="animate-pulse text-green-400">_</span>
        </pre>
      </div>
    </div>
  )
}

/**
 * PriorityDistributionBar Component
 * Stacked visualization of requirement priorities
 */
function PriorityDistributionBar({
  must,
  should,
  could,
  total,
}: {
  must: number
  should: number
  could: number
  total: number
}) {
  const segments = useMemo(() => {
    if (total === 0) return []

    const mustPercent = (must / total) * 100
    const shouldPercent = (should / total) * 100
    const couldPercent = (could / total) * 100

    return [
      { value: mustPercent, color: "#ef4444", label: `Must (${must})` },
      { value: shouldPercent, color: "#f59e0b", label: `Should (${should})` },
      { value: couldPercent, color: "#3b82f6", label: `Could (${could})` },
    ].filter(s => s.value > 0)
  }, [must, should, could, total])

  if (total === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-2">
        No requirements to display
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ProgressBar
        variant="stacked"
        segments={segments}
        height={12}
        ariaLabel="Requirement priority distribution"
      />
      {/* Legend */}
      <div className="flex items-center justify-center gap-6 text-xs">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-red-500" />
          <span className="text-muted-foreground">Must ({must})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-amber-500" />
          <span className="text-muted-foreground">Should ({should})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-blue-500" />
          <span className="text-muted-foreground">Could ({could})</span>
        </div>
      </div>
    </div>
  )
}

/**
 * AssessmentColumn Component
 * Single column for indicators or uncertainties
 */
function AssessmentColumn({
  title,
  items,
  icon: Icon,
  iconColor,
}: {
  title: string
  items: string[]
  icon: React.ComponentType<{ className?: string }>
  iconColor: string
}) {
  return (
    <div className="space-y-3">
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
 * DiscoveryView Component
 *
 * Displays the Discovery phase with "Mission Brief Command Center" aesthetic:
 * 1. IntentTerminal - Terminal-style intent display
 * 2. PriorityDistributionBar - Stacked priority visualization
 * 3. Dual-column assessment - Indicators vs Uncertainties
 * 4. Requirements grouped by priority
 */
export const DiscoveryView = observer(function DiscoveryView({
  feature,
}: DiscoveryViewProps) {
  // Phase colors for discovery (blue)
  const phaseColors = usePhaseColor("discovery")

  // Access platform-features domain for requirements
  const { platformFeatures } = useDomains()

  // Fetch requirements for this feature session
  const requirements = platformFeatures?.requirementCollection?.findBySession?.(feature.id) ?? []

  // Group requirements by priority
  const mustRequirements = requirements.filter((r: any) => r.priority === "must")
  const shouldRequirements = requirements.filter((r: any) => r.priority === "should")
  const couldRequirements = requirements.filter((r: any) => r.priority === "could")

  const { initialAssessment } = feature

  return (
    <div data-testid="discovery-view" className="space-y-6 overflow-hidden">
      {/* Mission Brief Header */}
      <div className={cn("flex items-center gap-2 pb-2 border-b min-w-0", phaseColors.border)}>
        <FileText className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Mission Brief
        </h2>
      </div>

      {/* Intent Terminal Section */}
      <section>
        <IntentTerminal intent={feature.intent} />
      </section>

      {/* Priority Distribution Section */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Requirement Distribution ({requirements.length})
        </h3>
        <PriorityDistributionBar
          must={mustRequirements.length}
          should={shouldRequirements.length}
          could={couldRequirements.length}
          total={requirements.length}
        />
      </section>

      {/* Initial Assessment Section - Dual Column Layout */}
      {initialAssessment && (
        <section>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Initial Assessment
          </h3>

          {/* Archetype Badge */}
          {initialAssessment.likelyArchetype && (
            <div className="flex items-center gap-2 mb-4 p-3 bg-muted/30 rounded-lg">
              <span className="text-sm text-muted-foreground">Likely Archetype:</span>
              <ArchetypeBadge archetype={initialAssessment.likelyArchetype} size="md" />
            </div>
          )}

          {/* Dual Column: Indicators vs Uncertainties */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 bg-muted/20 rounded-lg">
            <AssessmentColumn
              title="Indicators"
              items={initialAssessment.indicators || []}
              icon={CheckCircle}
              iconColor="text-green-500"
            />
            <AssessmentColumn
              title="Uncertainties"
              items={initialAssessment.uncertainties || []}
              icon={HelpCircle}
              iconColor="text-amber-500"
            />
          </div>
        </section>
      )}

      {/* Requirements Section */}
      <section>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Requirements
        </h3>

        {requirements.length === 0 ? (
          <div className="p-4 bg-muted/30 rounded-lg text-center">
            <p className="text-sm text-muted-foreground">
              No requirements captured yet
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Must Have */}
            {mustRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-red-600 dark:text-red-400 mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  Must Have ({mustRequirements.length})
                </h4>
                <div className="space-y-2">
                  {mustRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}

            {/* Should Have */}
            {shouldRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  Should Have ({shouldRequirements.length})
                </h4>
                <div className="space-y-2">
                  {shouldRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}

            {/* Could Have */}
            {couldRequirements.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  Could Have ({couldRequirements.length})
                </h4>
                <div className="space-y-2">
                  {couldRequirements.map((req: any) => (
                    <RequirementCard key={req.id} requirement={req} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
})

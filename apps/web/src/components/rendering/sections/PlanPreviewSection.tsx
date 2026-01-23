/**
 * PlanPreviewSection Component
 * Task: view-builder-spec
 *
 * Flexible wireframe renderer that displays ComponentSpec visually during planning.
 * Shows spec name, intent, type badge, layout approximation based on componentType,
 * data binding annotations, and status indicator.
 *
 * Used by view-builder skill to show evolving plans before implementation.
 *
 * Config options:
 * - specId: string - ComponentSpec ID to preview
 * - showAnnotations?: boolean - Show data binding annotations (default: true)
 * - theme?: "wireframe" | "mockup" - Visual theme (default: "wireframe")
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Layout,
  LayoutGrid,
  Component,
  FileCode,
  CheckCircle2,
  Clock,
  Pencil,
  Database,
  MousePointer,
} from "lucide-react"
import type { SectionRendererProps } from "../sectionImplementations"
import type {
  ComponentSpecPreviewSummary,
  DataBinding,
  LayoutDecision,
  ComponentRequirement,
} from "@shogo/state-api/component-builder"

/**
 * Status badge colors by spec status
 */
const statusStyles: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  draft: {
    bg: "bg-amber-500/10 border-amber-500/30",
    text: "text-amber-500",
    icon: <Pencil className="w-3 h-3" />,
  },
  approved: {
    bg: "bg-green-500/10 border-green-500/30",
    text: "text-green-500",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  implemented: {
    bg: "bg-blue-500/10 border-blue-500/30",
    text: "text-blue-500",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
}

/**
 * Component type badge styles
 */
const typeStyles: Record<string, { bg: string; icon: React.ReactNode }> = {
  section: {
    bg: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    icon: <Layout className="w-3 h-3" />,
  },
  renderer: {
    bg: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
    icon: <Component className="w-3 h-3" />,
  },
  composition: {
    bg: "bg-pink-500/10 text-pink-400 border-pink-500/30",
    icon: <LayoutGrid className="w-3 h-3" />,
  },
}

/**
 * Wireframe layout approximation based on component type
 */
function WireframeLayout({
  componentType,
  dataBindings,
  showAnnotations,
}: {
  componentType: "section" | "renderer" | "composition"
  dataBindings: DataBinding[]
  showAnnotations: boolean
}) {
  if (componentType === "section") {
    return (
      <div className="space-y-2">
        {/* Header placeholder */}
        <div className="h-8 bg-muted/40 rounded border border-dashed border-muted-foreground/20 flex items-center px-3">
          <div className="h-2 w-24 bg-muted-foreground/20 rounded" />
        </div>
        {/* Content area placeholder */}
        <div className="h-32 bg-muted/20 rounded border border-dashed border-muted-foreground/20 p-3">
          <div className="space-y-2">
            <div className="h-2 w-full bg-muted-foreground/10 rounded" />
            <div className="h-2 w-3/4 bg-muted-foreground/10 rounded" />
            <div className="h-2 w-5/6 bg-muted-foreground/10 rounded" />
          </div>
        </div>
        {/* Data binding annotations */}
        {showAnnotations && dataBindings.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {dataBindings.map((binding) => (
              <Badge
                key={binding.id}
                variant="outline"
                className="text-[10px] bg-blue-500/5 border-blue-500/20 text-blue-400"
              >
                <Database className="w-2.5 h-2.5 mr-1" />
                {binding.schema}.{binding.model}
              </Badge>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (componentType === "renderer") {
    return (
      <div className="flex items-center gap-3 p-4 bg-muted/20 rounded border border-dashed border-muted-foreground/20">
        {/* Value placeholder */}
        <div className="h-6 w-20 bg-muted-foreground/20 rounded" />
        {/* Config indicator */}
        <div className="h-4 w-4 bg-muted-foreground/10 rounded-full" />
      </div>
    )
  }

  // Composition - show multi-slot layout
  return (
    <div className="grid grid-cols-3 gap-2">
      {/* Slot placeholders */}
      <div className="col-span-2 h-24 bg-muted/30 rounded border border-dashed border-muted-foreground/20 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground">main</span>
      </div>
      <div className="h-24 bg-muted/20 rounded border border-dashed border-muted-foreground/20 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground">sidebar</span>
      </div>
      {/* Data binding annotations */}
      {showAnnotations && dataBindings.length > 0 && (
        <div className="col-span-3 flex flex-wrap gap-1 mt-1">
          {dataBindings.map((binding) => (
            <Badge
              key={binding.id}
              variant="outline"
              className="text-[10px] bg-blue-500/5 border-blue-500/20 text-blue-400"
            >
              <Database className="w-2.5 h-2.5 mr-1" />
              {binding.schema}.{binding.model}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Requirements summary display
 */
function RequirementsSummary({ requirements }: { requirements: ComponentRequirement[] }) {
  if (requirements.length === 0) return null

  const mustHave = requirements.filter((r) => r.priority === "must-have")
  const shouldHave = requirements.filter((r) => r.priority === "should-have")
  const couldHave = requirements.filter((r) => r.priority === "could-have")

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Requirements ({requirements.length})
      </h4>
      <div className="flex gap-2 text-xs">
        {mustHave.length > 0 && (
          <span className="text-red-400">{mustHave.length} must</span>
        )}
        {shouldHave.length > 0 && (
          <span className="text-amber-400">{shouldHave.length} should</span>
        )}
        {couldHave.length > 0 && (
          <span className="text-blue-400">{couldHave.length} could</span>
        )}
      </div>
    </div>
  )
}

/**
 * Layout decisions summary
 */
function LayoutDecisionsSummary({ decisions }: { decisions: LayoutDecision[] }) {
  if (decisions.length === 0) return null

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Layout Decisions ({decisions.length})
      </h4>
      <ul className="text-xs text-muted-foreground space-y-1">
        {decisions.slice(0, 3).map((d) => (
          <li key={d.id} className="truncate">
            <span className="text-foreground">{d.question}:</span> {d.decision}
          </li>
        ))}
        {decisions.length > 3 && (
          <li className="text-muted-foreground/60">+{decisions.length - 3} more...</li>
        )}
      </ul>
    </div>
  )
}

/**
 * PlanPreviewSection Component
 *
 * Displays a ComponentSpec as a flexible wireframe during planning.
 *
 * @param props - SectionRendererProps with config.specId
 */
export const PlanPreviewSection = observer(function PlanPreviewSection({
  feature,
  config,
}: SectionRendererProps) {
  const { componentBuilder } = useDomains()

  // Extract config options
  const specId = config?.specId as string | undefined
  const showAnnotations = config?.showAnnotations !== false
  const theme = (config?.theme as "wireframe" | "mockup") ?? "wireframe"

  // Handle missing specId
  if (!specId) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-6 text-center">
          <FileCode className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No ComponentSpec selected
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Use view-builder-spec skill to create a plan
          </p>
        </CardContent>
      </Card>
    )
  }

  // Fetch ComponentSpec
  const spec = componentBuilder?.componentSpecCollection?.get?.(specId)

  if (!spec) {
    return (
      <Card className="border-dashed border-amber-500/30">
        <CardContent className="p-6 text-center">
          <Clock className="w-8 h-8 mx-auto mb-2 text-amber-500/40" />
          <p className="text-sm text-amber-500">
            ComponentSpec not found
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            ID: {specId}
          </p>
        </CardContent>
      </Card>
    )
  }

  // Get preview summary and typed arrays
  const summary = spec.toPreviewSummary() as ComponentSpecPreviewSummary
  const requirements = spec.typedRequirements as ComponentRequirement[]
  const layoutDecisions = spec.typedLayoutDecisions as LayoutDecision[]
  const dataBindings = spec.typedDataBindings as DataBinding[]

  const status = statusStyles[summary.status] || statusStyles.draft
  const typeStyle = typeStyles[summary.componentType] || typeStyles.section

  return (
    <Card className={`${theme === "wireframe" ? "border-dashed" : ""}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 flex-1 min-w-0">
            <CardTitle className="text-base font-medium truncate">
              {summary.name}
            </CardTitle>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {summary.intent}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            {/* Status badge */}
            <Badge
              variant="outline"
              className={`${status.bg} ${status.text} text-[10px] gap-1`}
            >
              {status.icon}
              {summary.status}
            </Badge>
            {/* Type badge */}
            <Badge
              variant="outline"
              className={`${typeStyle.bg} text-[10px] gap-1`}
            >
              {typeStyle.icon}
              {summary.componentType}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Wireframe layout approximation */}
        <WireframeLayout
          componentType={summary.componentType}
          dataBindings={dataBindings}
          showAnnotations={showAnnotations}
        />

        {/* Schemas involved */}
        {summary.schemas.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {summary.schemas.map((schema) => (
              <Badge
                key={schema}
                variant="secondary"
                className="text-[10px]"
              >
                {schema}
              </Badge>
            ))}
          </div>
        )}

        {/* Requirements summary */}
        <RequirementsSummary requirements={requirements} />

        {/* Layout decisions summary */}
        <LayoutDecisionsSummary decisions={layoutDecisions} />

        {/* Stats footer */}
        <div className="flex items-center gap-4 pt-2 border-t border-border/50 text-[10px] text-muted-foreground">
          <span>{summary.requirementCount} requirements</span>
          <span>{summary.layoutDecisionCount} decisions</span>
          <span>{summary.dataBindingCount} bindings</span>
        </div>
      </CardContent>
    </Card>
  )
})

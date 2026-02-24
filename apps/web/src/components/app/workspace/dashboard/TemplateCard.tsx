/**
 * TemplateCard - Canvas example template card for the agent runtime
 *
 * Displays canvas dev examples as starter templates users can click
 * to pre-fill their prompt. Each card shows a name, tagline, and
 * whether the example uses a CRUD API or is display-only.
 */

import { cn } from "@/lib/utils"
import { Database, LayoutDashboard, MousePointerClick } from "lucide-react"

/**
 * A canvas example used as an agent template.
 * Sourced from the agent-runtime canvas eval fixtures.
 */
export interface CanvasTemplate {
  id: string
  user_request: string
  needs_api_schema: boolean
  component_types: string[]
  component_count: number
}

interface TemplateCardProps {
  template: CanvasTemplate
  onClick?: () => void
  isLoading?: boolean
}

export function formatTemplateName(id: string): string {
  return id
    .replace(/-crud$/, "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

const TEMPLATE_TAGLINES: Record<string, string> = {
  "weather-display": "Live weather forecast",
  "flight-search": "Search & pick flights",
  "email-dashboard": "Metrics, tabs & email tables",
  "analytics-dashboard": "Revenue charts & top products",
  "research-report": "Expandable sections & progress",
  "counter": "Simple interactive counter",
  "task-tracker-crud": "Add, complete & delete tasks",
  "stock-dashboard-crud": "Portfolio & price tracking",
  "meeting-scheduler": "Date/time pickers & submit",
  "notification-feed": "PR reviews, builds & reminders",
  "crm-pipeline": "Leads across pipeline stages",
  "expense-dashboard": "Spend, budgets & recent expenses",
  "cicd-monitor": "Deploy status & frequency",
  "support-tickets-crud": "Priority levels & status tracking",
  "invoice-tracker-crud": "Clients, amounts & due dates",
  "hr-pipeline-crud": "Applicants, stages & ratings",
  "social-media-dashboard": "Followers, trends & posts",
  "ecommerce-orders-crud": "Order metrics & status",
}

const TEMPLATE_ICONS: Record<string, string> = {
  "weather-display": "🌤️",
  "flight-search": "✈️",
  "email-dashboard": "📧",
  "analytics-dashboard": "📊",
  "research-report": "📑",
  "counter": "🔢",
  "task-tracker-crud": "✅",
  "stock-dashboard-crud": "📈",
  "meeting-scheduler": "📅",
  "notification-feed": "🔔",
  "crm-pipeline": "🤝",
  "expense-dashboard": "💰",
  "cicd-monitor": "🚀",
  "support-tickets-crud": "🎫",
  "invoice-tracker-crud": "🧾",
  "hr-pipeline-crud": "👥",
  "social-media-dashboard": "📱",
  "ecommerce-orders-crud": "🛒",
}

export function TemplateCard({
  template,
  onClick,
  isLoading,
}: TemplateCardProps) {
  const tagline =
    TEMPLATE_TAGLINES[template.id] ??
    template.user_request.slice(0, 50)
  const icon = TEMPLATE_ICONS[template.id] ?? "🧩"

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className={cn(
        "group flex flex-col text-left rounded-xl p-4 transition-all duration-200",
        "bg-card/60 backdrop-blur-sm border border-border/50",
        "hover:bg-card hover:border-border hover:shadow-md",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        "cursor-pointer",
        isLoading && "opacity-50 cursor-wait pointer-events-none"
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl shrink-0 mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-[15px] text-foreground leading-tight">
            {formatTemplateName(template.id)}
          </h3>
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
            {tagline}
          </p>
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 mt-3">
        {template.needs_api_schema ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Database className="h-3 w-3" />
            CRUD
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <LayoutDashboard className="h-3 w-3" />
            Display
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {template.component_count} components
        </span>
      </div>

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center rounded-xl">
          <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
        </div>
      )}
    </button>
  )
}

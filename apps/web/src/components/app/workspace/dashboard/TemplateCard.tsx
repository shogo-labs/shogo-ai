/**
 * TemplateCard - Display a single SDK template
 *
 * Shows template name, description, complexity badge, and tech stack.
 * Clicking the card selects the template for project creation.
 */

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  CheckSquare,
  DollarSign,
  Users,
  Package,
  Kanban,
  MessageSquare,
  FileText,
  ClipboardList,
  type LucideIcon,
} from "lucide-react"

/**
 * Template metadata from template.json
 */
export interface TemplateMetadata {
  name: string
  description: string
  complexity: "beginner" | "intermediate" | "advanced"
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: {
    database: string
    orm: string
    frontend: string
    router: string
    sdk: string
    [key: string]: string
  }
}

interface TemplateCardProps {
  template: TemplateMetadata
  onClick?: () => void
  isSelected?: boolean
  isLoading?: boolean
}

/**
 * Map template names to icons
 */
const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "todo-app": CheckSquare,
  "expense-tracker": DollarSign,
  crm: Users,
  inventory: Package,
  kanban: Kanban,
  "ai-chat": MessageSquare,
  "feedback-form": FileText,
  "form-builder": ClipboardList,
}

/**
 * Complexity badge colors
 */
const COMPLEXITY_COLORS: Record<string, string> = {
  beginner: "bg-green-500/10 text-green-500 border-green-500/20",
  intermediate: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  advanced: "bg-purple-500/10 text-purple-500 border-purple-500/20",
}

/**
 * Format template name for display
 * e.g., "todo-app" -> "Todo App"
 */
function formatTemplateName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export function TemplateCard({
  template,
  onClick,
  isSelected,
  isLoading,
}: TemplateCardProps) {
  const Icon = TEMPLATE_ICONS[template.name] ?? FileText
  const complexityColor =
    COMPLEXITY_COLORS[template.complexity] ?? COMPLEXITY_COLORS.beginner

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className={cn(
        "group p-4 bg-card rounded-lg border border-border transition-all duration-200 text-left w-full",
        "hover:border-primary/50 hover:shadow-md hover:shadow-primary/5",
        "focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background",
        isSelected && "border-primary ring-2 ring-primary/50",
        isLoading && "opacity-50 cursor-wait"
      )}
    >
      {/* Icon and title row */}
      <div className="flex items-start gap-3 mb-2">
        <div
          className={cn(
            "flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center",
            "group-hover:bg-primary/20 transition-colors"
          )}
        >
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm truncate">
            {formatTemplateName(template.name)}
          </h3>
          <Badge
            variant="outline"
            className={cn("text-[10px] px-1.5 py-0 h-4 mt-1", complexityColor)}
          >
            {template.complexity}
          </Badge>
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
        {template.description}
      </p>

      {/* Tech stack pills */}
      <div className="flex flex-wrap gap-1">
        {["prisma", "react", "tailwindcss"]
          .filter((tech) =>
            template.features.includes(tech) ||
            Object.values(template.techStack).some(
              (v) => v.toLowerCase().includes(tech.toLowerCase())
            )
          )
          .slice(0, 3)
          .map((tech) => (
            <span
              key={tech}
              className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
            >
              {tech}
            </span>
          ))}
        {template.models.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
            {template.models.length} models
          </span>
        )}
      </div>
    </button>
  )
}

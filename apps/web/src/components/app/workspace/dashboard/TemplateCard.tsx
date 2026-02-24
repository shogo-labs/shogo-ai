/**
 * TemplateCard - Template card matching Lovable's exact design
 *
 * Features:
 * - Large screenshot with visible border
 * - Bold title with short tagline description
 * - Subtle hover effects
 */

import { cn } from "@/lib/utils"

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
  /** Optional preview image URL */
  previewImage?: string
}

interface TemplateCardProps {
  template: TemplateMetadata
  onClick?: () => void
  isLoading?: boolean
}

/**
 * Format template name for display
 * e.g., "todo-app" -> "Todo App"
 */
export function formatTemplateName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Short tagline descriptions matching Lovable's style
 * These are punchy, descriptive phrases
 */
const TEMPLATE_TAGLINES: Record<string, string> = {
  "todo-app": "Simple task management",
  "expense-tracker": "Track spending & budgets",
  "crm": "Manage contacts & deals",
  "inventory": "Stock & supplier tracking",
  "kanban": "Visual project boards",
  "ai-chat": "AI-powered conversations",
  "feedback-form": "Collect user feedback",
  "form-builder": "Build custom forms",
  "booking-app": "Schedule appointments",
}

export function TemplateCard({
  template,
  onClick,
  isLoading,
}: TemplateCardProps) {
  const screenshotUrl = `/templates/${template.name}.png`
  const tagline = TEMPLATE_TAGLINES[template.name] || template.description.split(".")[0]

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className={cn(
        "group flex flex-col text-left transition-all duration-200",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        "cursor-pointer",
        isLoading && "opacity-50 cursor-wait pointer-events-none"
      )}
    >
      {/* Screenshot preview - matching Lovable's visible border style */}
      <div
        className={cn(
          "relative w-full aspect-[16/10] overflow-hidden rounded-lg",
          "bg-card border border-border/60",
          "transition-all duration-200"
        )}
      >
        <img
          src={screenshotUrl}
          alt={`${formatTemplateName(template.name)} preview`}
          className={cn(
            "w-full h-full object-cover object-top"
          )}
          loading="lazy"
          onError={(e) => {
            // Show placeholder on error
            const target = e.currentTarget
            target.style.display = 'none'
            const placeholder = target.parentElement?.querySelector('.placeholder')
            if (placeholder) {
              ;(placeholder as HTMLElement).style.display = 'flex'
            }
          }}
        />

        {/* Placeholder (hidden by default, shown on image error) */}
        <div 
          className="placeholder absolute inset-0 items-center justify-center bg-muted text-muted-foreground"
          style={{ display: 'none' }}
        >
          <div className="text-center p-4">
            <div className="text-4xl mb-2 opacity-40">📄</div>
            <p className="text-sm opacity-60">Preview unavailable</p>
          </div>
        </div>

        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Title and tagline - Lovable style */}
      <div className="pt-3 pb-1">
        <h3 className="font-semibold text-[15px] text-foreground">
          {formatTemplateName(template.name)}
        </h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {tagline}
        </p>
      </div>
    </button>
  )
}

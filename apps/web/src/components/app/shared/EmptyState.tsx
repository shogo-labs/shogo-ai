/**
 * EmptyState - Reusable empty state component
 * 
 * A visually appealing component for showing empty states with:
 * - SVG illustration
 * - Title and description
 * - Action button(s)
 * 
 * Inspired by Lovable.dev's empty states with friendly illustrations
 * and clear call-to-action buttons.
 */

import React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  FolderKanban,
  Star,
  Users,
  Compass,
  FileCode2,
  Search,
  Plus,
  type LucideIcon,
} from "lucide-react"

export type EmptyStateVariant =
  | "projects"
  | "starred"
  | "shared"
  | "discover"
  | "templates"
  | "search"
  | "features"
  | "custom"

interface EmptyStateProps {
  /** Pre-configured variant for common empty states */
  variant?: EmptyStateVariant
  /** Custom icon to display (used when variant is "custom") */
  icon?: LucideIcon
  /** Title text */
  title?: string
  /** Description text */
  description?: string
  /** Primary action button label */
  actionLabel?: string
  /** Primary action callback */
  onAction?: () => void
  /** Secondary action button label */
  secondaryLabel?: string
  /** Secondary action callback */
  onSecondaryAction?: () => void
  /** Additional className for container */
  className?: string
  /** Children to render below the description */
  children?: React.ReactNode
}

// Pre-configured content for each variant
const variantConfig: Record<
  Exclude<EmptyStateVariant, "custom">,
  { icon: LucideIcon; title: string; description: string; actionLabel?: string }
> = {
  projects: {
    icon: FolderKanban,
    title: "No projects yet",
    description: "Create your first project to get started building amazing things.",
    actionLabel: "Create project",
  },
  starred: {
    icon: Star,
    title: "No starred projects",
    description: "Star your favorite projects to quickly access them here.",
  },
  shared: {
    icon: Users,
    title: "Nothing shared with you",
    description: "When someone shares a project with you, it will appear here.",
  },
  discover: {
    icon: Compass,
    title: "Explore the community",
    description: "Discover amazing projects built by the community.",
    actionLabel: "Browse gallery",
  },
  templates: {
    icon: FileCode2,
    title: "Start from a template",
    description: "Choose from a variety of templates to jumpstart your project.",
    actionLabel: "Browse templates",
  },
  search: {
    icon: Search,
    title: "No results found",
    description: "Try adjusting your search or filters to find what you're looking for.",
  },
  features: {
    icon: FolderKanban,
    title: "No features yet",
    description: "Create your first feature to start building this project.",
    actionLabel: "New Feature",
  },
}

/**
 * Decorative SVG illustration for empty states
 * Creates a visually appealing background with abstract shapes
 */
function EmptyStateIllustration({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="relative w-48 h-48 mx-auto mb-6">
      {/* Background gradient circle */}
      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary/10 via-primary/5 to-transparent" />
      
      {/* Decorative shapes */}
      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-primary/10 animate-pulse" />
      <div className="absolute bottom-8 right-4 w-6 h-6 rounded-full bg-primary/20 animate-pulse delay-150" />
      <div className="absolute top-12 right-8 w-4 h-4 rounded-full bg-primary/15 animate-pulse delay-300" />
      
      {/* Main icon container */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-24 h-24 rounded-2xl bg-card border border-border shadow-lg flex items-center justify-center">
          <Icon className="w-12 h-12 text-primary/60" />
        </div>
      </div>
      
      {/* Floating dots */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 200 200">
        <circle cx="20" cy="80" r="2" fill="currentColor" className="text-primary/30" />
        <circle cx="180" cy="100" r="2" fill="currentColor" className="text-primary/20" />
        <circle cx="40" cy="160" r="1.5" fill="currentColor" className="text-primary/25" />
        <circle cx="160" cy="40" r="1.5" fill="currentColor" className="text-primary/25" />
      </svg>
    </div>
  )
}

/**
 * EmptyState component
 * 
 * Displays a friendly empty state with illustration, message, and action.
 * Can be used with pre-configured variants or fully customized.
 */
export function EmptyState({
  variant = "custom",
  icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction,
  className,
  children,
}: EmptyStateProps) {
  // Get config from variant or use custom props
  const config = variant !== "custom" ? variantConfig[variant] : null
  
  const finalIcon = icon || config?.icon || FolderKanban
  const finalTitle = title || config?.title || "Nothing here yet"
  const finalDescription = description || config?.description || "There's nothing to show at the moment."
  const finalActionLabel = actionLabel || config?.actionLabel

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 px-4 text-center",
        className
      )}
    >
      <EmptyStateIllustration icon={finalIcon} />
      
      <h3 className="text-xl font-semibold mb-2">{finalTitle}</h3>
      <p className="text-muted-foreground max-w-sm mb-6">{finalDescription}</p>
      
      {children}
      
      {(finalActionLabel || secondaryLabel) && (
        <div className="flex items-center gap-3">
          {finalActionLabel && onAction && (
            <Button onClick={onAction} className="gap-2">
              <Plus className="h-4 w-4" />
              {finalActionLabel}
            </Button>
          )}
          {secondaryLabel && onSecondaryAction && (
            <Button variant="outline" onClick={onSecondaryAction}>
              {secondaryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

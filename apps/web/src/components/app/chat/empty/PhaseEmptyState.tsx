/**
 * PhaseEmptyState Component
 * Task: task-chat-007
 *
 * Phase-contextual empty state with suggested prompts.
 * Shows phase-specific icon, title, and clickable suggestion chips.
 */

import { cn } from "@/lib/utils"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import {
  Compass,
  Search,
  Layers,
  Palette,
  FileText,
  TestTube,
  Hammer,
  CheckCircle,
  MessageSquare,
} from "lucide-react"

/** Phase-specific suggestions */
const PHASE_SUGGESTIONS: Record<string, string[]> = {
  discovery: [
    "Add a requirement",
    "Describe the feature",
    "What problem are we solving?",
    "Who are the users?",
  ],
  analysis: [
    "Find patterns",
    "Check integration points",
    "Identify risks",
    "Review existing code",
  ],
  classification: [
    "Validate archetype",
    "Check evidence",
    "Review patterns",
  ],
  design: [
    "Create schema",
    "Define entities",
    "Design the domain model",
  ],
  spec: [
    "Create implementation tasks",
    "Define acceptance criteria",
    "Review dependencies",
  ],
  testing: [
    "Generate test specs",
    "Define test cases",
    "Review coverage",
  ],
  implementation: [
    "Run tests",
    "Check task status",
    "Implement next task",
    "Review progress",
  ],
  complete: [
    "Review summary",
    "Create documentation",
    "Start new feature",
  ],
}

/** Phase-specific icons */
const PHASE_ICONS: Record<string, typeof MessageSquare> = {
  discovery: Compass,
  analysis: Search,
  classification: Layers,
  design: Palette,
  spec: FileText,
  testing: TestTube,
  implementation: Hammer,
  complete: CheckCircle,
}

/** Phase-specific titles */
const PHASE_TITLES: Record<string, string> = {
  discovery: "Start Discovery",
  analysis: "Explore Codebase",
  classification: "Validate Classification",
  design: "Design Schema",
  spec: "Create Implementation Spec",
  testing: "Define Tests",
  implementation: "Begin Implementation",
  complete: "Feature Complete",
}

export interface PhaseEmptyStateProps {
  /** Current phase */
  phase: string | null
  /** Callback when a suggestion is clicked */
  onSuggestionClick?: (suggestion: string) => void
  /** Optional class name */
  className?: string
}

/**
 * Phase-contextual empty state for chat panel.
 *
 * Features:
 * - Phase-specific icon and title
 * - Suggested prompts as clickable chips
 * - Uses phase colors for styling
 * - Typography follows design tokens
 *
 * @example
 * ```tsx
 * <PhaseEmptyState
 *   phase="discovery"
 *   onSuggestionClick={(text) => sendMessage(text)}
 * />
 * ```
 */
export function PhaseEmptyState({
  phase,
  onSuggestionClick,
  className,
}: PhaseEmptyStateProps) {
  const phaseKey = phase || "discovery"
  const colors = usePhaseColor(phaseKey)

  const Icon = PHASE_ICONS[phaseKey] || MessageSquare
  const title = PHASE_TITLES[phaseKey] || "Start Chatting"
  const suggestions = PHASE_SUGGESTIONS[phaseKey] || ["Type a message"]

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-8 px-4",
        className
      )}
    >
      {/* Phase icon */}
      <div
        className={cn(
          "w-12 h-12 rounded-full flex items-center justify-center mb-4",
          colors.bg,
          "bg-opacity-10 dark:bg-opacity-20"
        )}
      >
        <Icon className={cn("w-6 h-6", colors.text)} />
      </div>

      {/* Title */}
      <h3
        className={cn(
          "text-sm font-semibold mb-2",
          colors.text
        )}
        style={{ fontFamily: "var(--font-body)" }}
      >
        {title}
      </h3>

      {/* Subtitle */}
      <p className="text-xs text-muted-foreground mb-4">
        Try one of these suggestions to get started
      </p>

      {/* Suggestion chips */}
      <div className="flex flex-wrap justify-center gap-2 max-w-xs">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestionClick?.(suggestion)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs",
              "bg-muted/50 hover:bg-muted transition-colors",
              "border border-border/50",
              colors.border,
              "hover:border-opacity-50",
              onSuggestionClick && "cursor-pointer",
              !onSuggestionClick && "cursor-default"
            )}
            style={{ fontFamily: "var(--font-body)" }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

export default PhaseEmptyState

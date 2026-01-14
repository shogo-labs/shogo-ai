/**
 * BlankState Component
 *
 * Displays a centered empty state when the workspace has no open panels.
 * Features a Sparkles icon, welcoming heading, and supportive subtext.
 *
 * Task: task-testbed-blank-state
 * Feature: virtual-tools-domain
 */

import { Sparkles } from "lucide-react"

export interface BlankStateProps {
  /** Optional callback for future quick action suggestions */
  onSuggestionClick?: (suggestion: string) => void
}

export function BlankState({ onSuggestionClick }: BlankStateProps) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-md">
        <Sparkles className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
        <h2 className="text-xl font-semibold mb-2">How can I help you build today?</h2>
        <p className="text-muted-foreground">
          Describe what you want to create, and I'll help you build it step by step.
        </p>
      </div>
    </div>
  )
}

/**
 * RunPhaseButton Component
 * Task: task-2-3a-006, task-2-4-006
 *
 * Button to trigger skill execution for a phase.
 * Wired to ChatContext in 2.4 - sends skill invocation message via chat.
 *
 * Per design-2-3a-enhancement-hooks-plan:
 * - RunPhaseButton has disabled+onRun props
 * - 2.3D provides onRun callback to trigger skill
 *
 * Per task-2-4-006:
 * - RunPhaseButton imports useChatContextSafe from ChatContext
 * - Accesses sendMessage from context when available
 * - Formats message: 'Execute /{phaseName} skill for feature session {featureName}'
 * - Disabled when chat context unavailable (graceful fallback)
 * - Enabled when chat context available
 *
 * Per finding-2-3a-006 (NewFeatureButton pattern):
 * - Uses disabled prop, title attribute, aria-label with disabled explanation
 *
 * Per design-2-3a-clean-break:
 * - Built fresh in /components/app/stepper/
 * - Zero imports from /components/Studio/
 */

import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useChatContextSafe } from "../chat/ChatContext"

/**
 * Props for RunPhaseButton component
 */
export interface RunPhaseButtonProps {
  /** Phase name for skill invocation (e.g., "discovery", "analysis") */
  phaseName: string
  /** Feature name for skill invocation message */
  featureName?: string
  /** Whether button is disabled - overrides context-based logic if explicitly set to true */
  disabled?: boolean
  /** Optional callback when button is clicked - overrides context-based invocation */
  onRun?: () => void
}

/**
 * RunPhaseButton Component
 *
 * Renders a button to trigger skill execution for a phase.
 * When inside ChatContextProvider, uses sendMessage to invoke skill via chat.
 * When outside provider, button is gracefully disabled.
 *
 * Usage:
 * ```tsx
 * // Inside ChatContextProvider - button is enabled, sends chat message
 * <ChatContextProvider value={...}>
 *   <RunPhaseButton phaseName="discovery" featureName="my-feature" />
 * </ChatContextProvider>
 *
 * // Outside provider - button is disabled (graceful fallback)
 * <RunPhaseButton phaseName="discovery" featureName="my-feature" />
 *
 * // With explicit onRun callback (legacy behavior)
 * <RunPhaseButton phaseName="discovery" disabled={false} onRun={() => console.log('run')} />
 * ```
 */
export function RunPhaseButton({
  phaseName,
  featureName,
  disabled,
  onRun,
}: RunPhaseButtonProps) {
  // Access chat context safely - returns null if outside provider
  const chatContext = useChatContextSafe()

  // Determine if button should be disabled:
  // - If explicit disabled=true prop is passed, always disabled
  // - If no chat context and no onRun callback, disabled (graceful fallback)
  // - Otherwise, enabled
  const isDisabled =
    disabled === true ||
    (disabled !== false && !chatContext && !onRun)

  // Handle button click
  const handleClick = () => {
    // If explicit onRun callback is provided, use it (legacy/override behavior)
    if (onRun) {
      onRun()
      return
    }

    // If chat context is available, send skill invocation message
    if (chatContext) {
      const message = `Execute /${phaseName} skill for feature session ${featureName ?? 'unknown'}`
      chatContext.sendMessage(message)
    }
  }

  const disabledTitle = "Run phase via Chat UI - skill execution available in Chat window"
  const enabledTitle = `Run ${phaseName} skill`

  return (
    <Button
      onClick={handleClick}
      disabled={isDisabled}
      variant="outline"
      size="sm"
      title={isDisabled ? disabledTitle : enabledTitle}
      aria-label={isDisabled ? disabledTitle : enabledTitle}
      data-testid="run-phase-button"
    >
      <Play className="h-4 w-4 mr-1" />
      Run
    </Button>
  )
}

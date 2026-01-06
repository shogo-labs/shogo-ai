/**
 * LoadingOverlay Component
 * Task: task-3-1-008
 *
 * A subtle loading indicator that applies a breathing ring effect to content
 * during data refresh. Non-intrusive - just a gentle border glow.
 *
 * Features:
 * - Breathing ring animation (opacity pulse on primary color ring)
 * - No overlay or blur - content remains fully visible and interactive
 * - Coordinated with isPolling state from useFeaturePolling
 * - Consistent styling across all phase views
 */

import { cn } from "@/lib/utils"

export interface LoadingOverlayProps {
  /** Whether the loading indicator is active */
  isLoading: boolean
  /** Optional class name for customization */
  className?: string
  /** Optional children - the content that gets the ring effect */
  children?: React.ReactNode
}

/**
 * LoadingOverlay Component
 *
 * Applies a subtle breathing ring effect during data refresh.
 * The content remains fully visible and interactive - just adds
 * a gentle pulsing border glow to indicate background activity.
 *
 * @example
 * ```tsx
 * <LoadingOverlay isLoading={isPolling}>
 *   <PhaseContent />
 * </LoadingOverlay>
 * ```
 */
export function LoadingOverlay({
  isLoading,
  className,
  children,
}: LoadingOverlayProps) {
  return (
    <div
      className={cn(
        "relative rounded-lg transition-shadow duration-300",
        // Breathing ring effect when loading
        isLoading && "ring-2 ring-primary/30 animate-pulse",
        className
      )}
      data-testid={isLoading ? "loading-overlay" : undefined}
      aria-busy={isLoading}
    >
      {children}
    </div>
  )
}


/**
 * TurnHeader Component
 * Task: task-chat-004
 *
 * Shows role, timestamp, and phase badge for a conversation turn.
 */

import { cn } from "@/lib/utils"
import { User, Bot } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"

export interface TurnHeaderProps {
  /** Message role */
  role: "user" | "assistant"
  /** Timestamp to display */
  timestamp?: Date
  /** Current phase (for assistant turns) */
  phase?: string | null
  /** Optional class name */
  className?: string
}

/**
 * Header for a conversation turn showing role and metadata.
 *
 * Features:
 * - Role icon and label
 * - Timestamp in Space Mono font
 * - Phase badge for assistant turns
 *
 * @example
 * ```tsx
 * <TurnHeader role="assistant" timestamp={new Date()} phase="discovery" />
 * ```
 */
export function TurnHeader({
  role,
  timestamp,
  phase,
  className,
}: TurnHeaderProps) {
  const colors = usePhaseColor(phase || "")

  // Format timestamp
  const formattedTime = timestamp
    ? timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <div className={cn("flex items-center gap-1.5 mb-0.5", className)}>
      {/* Role icon */}
      {role === "user" ? (
        <div className="w-4 h-4 rounded-full bg-primary/10 flex items-center justify-center">
          <User className="w-2.5 h-2.5 text-primary" />
        </div>
      ) : (
        <div className="w-4 h-4 rounded-full bg-muted flex items-center justify-center">
          <Bot className="w-2.5 h-2.5 text-muted-foreground" />
        </div>
      )}

      {/* Role label */}
      <span
        className={cn(
          "text-[10px] font-medium",
          role === "user" ? "text-primary" : "text-muted-foreground"
        )}
        style={{ fontFamily: "var(--font-body)" }}
      >
        {role === "user" ? "You" : "Shogo"}
      </span>

      {/* Timestamp */}
      {formattedTime && (
        <span
          className="text-[9px] text-muted-foreground/60"
          style={{ fontFamily: "'Space Mono', monospace" }}
        >
          {formattedTime}
        </span>
      )}

      {/* Phase badge for assistant */}
      {role === "assistant" && phase && (
        <span
          className={cn(
            "text-[9px] px-1 py-0.5 rounded",
            colors.accent
          )}
        >
          {phase}
        </span>
      )}
    </div>
  )
}

export default TurnHeader

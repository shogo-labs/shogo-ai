/**
 * ChatInput Component
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Renders a textarea with submit button for chat input.
 * Uses shadcn components. Calls onSubmit with content and clears input.
 * Supports disabled state and stop button during streaming.
 */

import * as React from "react"
import { useCallback, useRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Send, Square } from "lucide-react"

export interface ChatInputProps {
  onSubmit: (content: string) => void
  disabled?: boolean
  placeholder?: string
  /** Whether a stream is currently in progress */
  isStreaming?: boolean
  /** Callback to stop the current stream */
  onStop?: () => void
}

export function ChatInput({
  onSubmit,
  disabled = false,
  placeholder = "Type a message...",
  isStreaming = false,
  onStop,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const trimmedContent = textarea.value.trim()
    if (!trimmedContent || disabled) return

    onSubmit(trimmedContent)
    textarea.value = ""

    // Focus textarea after submit
    textarea.focus()
  }, [disabled, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter without Shift (Shift+Enter for newline)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className="flex items-end gap-2 p-2">
      <Textarea
        ref={textareaRef}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "min-h-[60px] max-h-[200px] resize-none flex-1",
          disabled && "cursor-not-allowed opacity-50"
        )}
        rows={1}
      />
      {isStreaming ? (
        <Button
          type="button"
          onClick={onStop}
          variant="destructive"
          size="icon"
          className="h-[60px] w-[60px] shrink-0"
        >
          <Square className="h-5 w-5" />
          <span className="sr-only">Stop generation</span>
        </Button>
      ) : (
        <Button
          type="submit"
          onClick={handleSubmit}
          disabled={disabled}
          size="icon"
          className={cn(
            "h-[60px] w-[60px] shrink-0",
            disabled && "pointer-events-none opacity-50"
          )}
        >
          <Send className="h-5 w-5" />
          <span className="sr-only">Send message</span>
        </Button>
      )}
    </div>
  )
}

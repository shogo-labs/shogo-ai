/**
 * CompactChatInput - Homepage-styled chat input for ChatPanel compact mode
 *
 * Matches the visual styling of the original HomePage input card:
 * - Translucent card with backdrop blur
 * - Attach/Theme buttons on left, Chat/Send buttons on right
 * - min-h-[80px] textarea with custom placeholder styling
 *
 * Used when ChatPanel is in mode="compact" on the homepage.
 */

import { useState, useRef, useCallback, forwardRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Paperclip, Send, Loader2 } from "lucide-react"
import { ThemeSelector } from "@/components/app/shared/ThemeSelector"

export interface CompactChatInputProps {
  /** Callback when user submits a prompt */
  onSubmit: (prompt: string) => void
  /** Whether the input is disabled (e.g., during loading) */
  disabled?: boolean
  /** Whether a submission is in progress */
  isLoading?: boolean
  /** Placeholder text for the textarea */
  placeholder?: string
  /** Optional class name for the root container */
  className?: string
  /** Controlled value for the textarea */
  value?: string
  /** Callback when textarea value changes */
  onChange?: (value: string) => void
  /** Currently selected theme ID */
  selectedThemeId?: string
  /** Callback when theme is selected */
  onSelectTheme?: (themeId: string) => void
  /** Callback when "Create new theme" is clicked */
  onCreateTheme?: () => void
}

export const CompactChatInput = forwardRef<HTMLDivElement, CompactChatInputProps>(
  function CompactChatInput(
    {
      onSubmit,
      disabled = false,
      isLoading = false,
      placeholder = "Ask Shogo to create a web app that...",
      className,
      value: controlledValue,
      onChange: controlledOnChange,
      selectedThemeId = "default",
      onSelectTheme,
      onCreateTheme,
    },
    ref
  ) {
    // Internal state for uncontrolled mode
    const [internalValue, setInternalValue] = useState("")
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Use controlled or uncontrolled value
    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue

    const handleSubmit = useCallback(() => {
      if (value.trim() && !disabled && !isLoading) {
        onSubmit(value.trim())
        // Don't clear - let parent handle state after navigation
      }
    }, [value, disabled, isLoading, onSubmit])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          handleSubmit()
        }
      },
      [handleSubmit]
    )

    return (
      <div ref={ref} className={cn("w-full", className)}>
        <div className="bg-card/80 backdrop-blur-sm border border-border rounded-xl shadow-lg overflow-hidden">
          {/* Input area */}
          <div className="p-4">
            <Textarea
              ref={textareaRef}
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled || isLoading}
              className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-base focus-visible:ring-0 placeholder:text-muted-foreground/60"
              rows={3}
            />
          </div>

          {/* Action bar */}
          <div className="px-4 pb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
                disabled={disabled || isLoading}
              >
                <Paperclip className="h-4 w-4" />
                <span className="hidden sm:inline text-xs">Attach</span>
              </Button>
              <ThemeSelector
                selectedThemeId={selectedThemeId}
                onSelectTheme={onSelectTheme ?? (() => {})}
                onCreateNew={onCreateTheme}
                disabled={disabled || isLoading}
                variant="compact"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                className="h-8 px-3"
                onClick={handleSubmit}
                disabled={!value.trim() || disabled || isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
)

export default CompactChatInput

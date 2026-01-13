/**
 * ChatInput Component
 * Task: task-2-4-002 (chat-presentational-components)
 * Task: task-chatinput-image-capture (image attachment support)
 *
 * Renders a textarea with submit button for chat input.
 * Uses shadcn components. Calls onSubmit with content and clears input.
 * Supports disabled state and stop button during streaming.
 * Supports image attachments via paste (Ctrl/Cmd+V) or file picker.
 */

import * as React from "react"
import { useCallback, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Send, Square, Paperclip, X } from "lucide-react"

// Maximum file size in bytes (4MB)
const MAX_IMAGE_SIZE = 4 * 1024 * 1024

export interface ChatInputProps {
  onSubmit: (content: string, imageData?: string) => void
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
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Image attachment state
  const [pendingImage, setPendingImage] = useState<string | undefined>(undefined)
  const [imageError, setImageError] = useState<string | null>(null)

  /**
   * Process an image file and convert to base64 data URL
   */
  const processImageFile = useCallback((file: File) => {
    // Validate file size
    if (file.size > MAX_IMAGE_SIZE) {
      setImageError(`Image must be smaller than 4MB (current: ${(file.size / 1024 / 1024).toFixed(1)}MB)`)
      return
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setImageError("Only image files are supported")
      return
    }

    // Clear any previous error
    setImageError(null)

    // Read file as data URL
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      setPendingImage(dataUrl)
    }
    reader.onerror = () => {
      setImageError("Failed to read image file")
    }
    reader.readAsDataURL(file)
  }, [])

  /**
   * Handle paste events to capture images from clipboard
   */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Look for image items in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault() // Prevent default paste behavior for images
          processImageFile(file)
          return
        }
      }
    }
    // For non-image content, let the default paste behavior handle it
  }, [processImageFile])

  /**
   * Handle file input change
   */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      processImageFile(file)
    }
    // Reset file input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [processImageFile])

  /**
   * Open file picker
   */
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  /**
   * Remove attached image
   */
  const handleRemoveImage = useCallback(() => {
    setPendingImage(undefined)
    setImageError(null)
  }, [])

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const trimmedContent = textarea.value.trim()
    if ((!trimmedContent && !pendingImage) || disabled) return

    onSubmit(trimmedContent, pendingImage)
    textarea.value = ""
    setPendingImage(undefined)
    setImageError(null)

    // Focus textarea after submit
    textarea.focus()
  }, [disabled, onSubmit, pendingImage])

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
    <div className="flex flex-col gap-2 p-2">
      {/* Image preview */}
      {pendingImage && (
        <div
          data-testid="image-preview"
          className="relative inline-block max-w-[200px]"
        >
          <img
            src={pendingImage}
            alt="Attached image"
            className="max-h-[100px] rounded-lg border border-border object-cover"
          />
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute -right-2 -top-2 h-6 w-6"
            onClick={handleRemoveImage}
            data-testid="remove-image-button"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Remove image</span>
          </Button>
        </div>
      )}

      {/* Error message */}
      {imageError && (
        <div
          data-testid="image-error"
          className="text-sm text-destructive"
        >
          {imageError}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Attach button */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleAttachClick}
          disabled={disabled}
          className="h-[60px] w-[40px] shrink-0"
          data-testid="attach-image-button"
        >
          <Paperclip className="h-5 w-5" />
          <span className="sr-only">Attach image</span>
        </Button>

        <Textarea
          ref={textareaRef}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
    </div>
  )
}

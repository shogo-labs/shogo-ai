/**
 * CompactChatInput - Homepage-styled chat input for ChatPanel compact mode
 *
 * Matches the visual styling of the original HomePage input card:
 * - Translucent card with backdrop blur
 * - Attach/Theme buttons on left, Chat/Send buttons on right
 * - min-h-[80px] textarea with custom placeholder styling
 * - Supports file attachments (images and other files) via paste or file picker
 *
 * Used when ChatPanel is in mode="compact" on the homepage.
 */

import { useState, useRef, useCallback, forwardRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Paperclip, Send, Loader2, X, File } from "lucide-react"
import { ThemeSelector } from "@/components/app/shared/ThemeSelector"

// Maximum file size in bytes (5MB for images, 10MB for other files)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_FILE_SIZE = 10 * 1024 * 1024

export interface CompactChatInputProps {
  /** Callback when user submits a prompt */
  onSubmit: (prompt: string, fileData?: string) => void
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
    const fileInputRef = useRef<HTMLInputElement>(null)

    // File attachment state (supports images and other files)
    const [pendingFile, setPendingFile] = useState<{ dataUrl: string; name: string; type: string; size: number } | undefined>(undefined)
    const [fileError, setFileError] = useState<string | null>(null)

    // Use controlled or uncontrolled value
    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue

    /**
     * Process a file and convert to base64 data URL
     * Supports both images and other file types
     */
    const processFile = useCallback((file: File) => {
      const isImage = file.type.startsWith("image/")
      const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE
      const maxSizeMB = isImage ? 5 : 10

      // Validate file size
      if (file.size > maxSize) {
        setFileError(`File must be smaller than ${maxSizeMB}MB (current: ${(file.size / 1024 / 1024).toFixed(1)}MB)`)
        return
      }

      // Clear any previous error
      setFileError(null)

      // Read file as data URL
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setPendingFile({
          dataUrl,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
        })
      }
      reader.onerror = () => {
        setFileError("Failed to read file")
      }
      reader.readAsDataURL(file)
    }, [])

    /**
     * Handle file input change
     */
    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        processFile(file)
      }
      // Reset file input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }, [processFile])

    /**
     * Handle paste events to capture files from clipboard
     */
    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return

      // Look for file items in clipboard (images are most common)
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === "file") {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault() // Prevent default paste behavior for files
            processFile(file)
            return
          }
        }
      }
      // For non-file content, let the default paste behavior handle it
    }, [processFile])

    /**
     * Open file picker
     */
    const handleAttachClick = useCallback(() => {
      fileInputRef.current?.click()
    }, [])

    /**
     * Remove attached file
     */
    const handleRemoveFile = useCallback(() => {
      setPendingFile(undefined)
      setFileError(null)
    }, [])

    const handleSubmit = useCallback(() => {
      if ((!value.trim() && !pendingFile) || disabled || isLoading) return
      onSubmit(value.trim(), pendingFile?.dataUrl)
      // Don't clear - let parent handle state after navigation
      // But clear file since we're submitting
      setPendingFile(undefined)
      setFileError(null)
    }, [value, pendingFile, disabled, isLoading, onSubmit])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          handleSubmit()
        }
      },
      [handleSubmit]
    )

    const isImage = pendingFile?.type.startsWith("image/")

    return (
      <div ref={ref} className={cn("w-full", className)}>
        {/* File preview - shown above the input container */}
        {pendingFile && (
          <div
            data-testid="image-preview"
            className="relative inline-block max-w-[300px] mb-2"
          >
            {isImage ? (
              <div className="relative">
                <img
                  src={pendingFile.dataUrl}
                  alt="Attached image"
                  className="max-h-[100px] rounded-lg border border-border object-cover"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute -right-2 -top-2 h-6 w-6"
                  onClick={handleRemoveFile}
                  data-testid="remove-image-button"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove file</span>
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 p-2 rounded-lg border border-border bg-muted">
                <File className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{pendingFile.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(pendingFile.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={handleRemoveFile}
                  data-testid="remove-image-button"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove file</span>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Error message */}
        {fileError && (
          <div
            data-testid="image-error"
            className="text-sm text-destructive mb-2"
          >
            {fileError}
          </div>
        )}

        <div className="bg-card/80 backdrop-blur-sm border border-border rounded-xl shadow-lg overflow-hidden">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Input area */}
          <div className="p-4">
            <Textarea
              ref={textareaRef}
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
                onClick={handleAttachClick}
                data-testid="attach-image-button"
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
                disabled={(!value.trim() && !pendingFile) || disabled || isLoading}
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

/**
 * ChatInput Component
 * Task: task-2-4-002 (chat-presentational-components)
 * Task: task-chatinput-image-capture (image attachment support)
 *
 * Lovable.dev-style chat input with:
 * - Rounded container with subtle border
 * - Clean textarea with "Ask Shogo..." placeholder
 * - Bottom toolbar with action buttons
 *
 * Supports image attachments via paste (Ctrl/Cmd+V) or file picker.
 */

import * as React from "react"
import { useCallback, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  ArrowUp,
  Plus,
  Square,
  X,
  MessageSquare,
  BarChart3,
  Sparkles,
} from "lucide-react"

// Maximum file size in bytes (4MB)
const MAX_IMAGE_SIZE = 4 * 1024 * 1024

// Skills loaded from VITE_SHOGO_SKILLS env var (set at build time)
interface SkillOption {
  name: string
  description: string
}

const SKILLS: SkillOption[] = (() => {
  try {
    return JSON.parse(import.meta.env.VITE_SHOGO_SKILLS || "[]")
  } catch {
    return []
  }
})()

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
  placeholder = "Ask Shogo...",
  isStreaming = false,
  onStop,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Image attachment state
  const [pendingImage, setPendingImage] = useState<string | undefined>(undefined)
  const [imageError, setImageError] = useState<string | null>(null)

  // Skill picker state
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [filterText, setFilterText] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Filter skills based on user input
  const filteredSkills = useMemo(() => {
    if (!filterText) return SKILLS
    const lower = filterText.toLowerCase()
    return SKILLS.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower)
    )
  }, [filterText])

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

  /**
   * Handle input changes to detect slash commands
   */
  const handleInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const value = e.currentTarget.value
      // Show picker when input starts with / and has no space yet
      if (value.startsWith("/") && !value.includes(" ")) {
        setShowSkillPicker(true)
        setFilterText(value.slice(1).toLowerCase())
        setSelectedIndex(0)
      } else {
        setShowSkillPicker(false)
      }
    },
    []
  )

  /**
   * Select a skill from the picker
   */
  const selectSkill = useCallback((skill: SkillOption) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const currentValue = textarea.value
    const spaceIndex = currentValue.indexOf(" ")
    const afterPrefix = spaceIndex === -1 ? "" : currentValue.slice(spaceIndex)

    textarea.value = `/${skill.name}${afterPrefix || " "}`
    setShowSkillPicker(false)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
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
      // Handle skill picker navigation when open
      if (showSkillPicker && filteredSkills.length > 0) {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault()
            setSelectedIndex((i) => Math.min(i + 1, filteredSkills.length - 1))
            return
          case "ArrowUp":
            e.preventDefault()
            setSelectedIndex((i) => Math.max(i - 1, 0))
            return
          case "Enter":
          case "Tab":
            e.preventDefault()
            selectSkill(filteredSkills[selectedIndex])
            return
          case "Escape":
            e.preventDefault()
            setShowSkillPicker(false)
            return
        }
      }

      // Submit on Enter without Shift (Shift+Enter for newline)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit, showSkillPicker, filteredSkills, selectedIndex, selectSkill]
  )

  return (
    <div className="p-3">
      {/* Image preview - shown above the input container */}
      {pendingImage && (
        <div
          data-testid="image-preview"
          className="relative inline-block max-w-[200px] mb-2"
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
          className="text-sm text-destructive mb-2"
        >
          {imageError}
        </div>
      )}

      {/* Main input container - Lovable.dev style */}
      <div className="relative rounded-xl border border-border/60 bg-muted/30 overflow-hidden">
        {/* Skill picker dropdown */}
        {showSkillPicker && filteredSkills.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto rounded-md border border-border bg-popover shadow-md z-50">
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => selectSkill(skill)}
                className={cn(
                  "w-full px-3 py-2 text-left text-sm hover:bg-accent",
                  index === selectedIndex && "bg-accent"
                )}
              >
                <div className="font-medium">/{skill.name}</div>
                <div className="text-xs text-muted-foreground">
                  {skill.description}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Textarea - clean, borderless */}
        <Textarea
          ref={textareaRef}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "min-h-[60px] max-h-[200px] resize-none w-full",
            "border-0 bg-transparent shadow-none focus-visible:ring-0",
            "px-4 pt-4 pb-2 text-base",
            disabled && "cursor-not-allowed opacity-50"
          )}
          rows={1}
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-2 pb-2">
          {/* Left side buttons */}
          <div className="flex items-center gap-1">
            {/* Add/Attach button */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleAttachClick}
              disabled={disabled}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
              data-testid="attach-image-button"
            >
              <Plus className="h-4 w-4" />
              <span className="sr-only">Attach</span>
            </Button>

            {/* Visual edits button */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="h-8 gap-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted px-3"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-xs">Visual edits</span>
            </Button>
          </div>

          {/* Right side buttons */}
          <div className="flex items-center gap-1">
            {/* Chat mode button */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              className="h-8 gap-1.5 rounded-full px-3 border-border/60"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="text-xs">Chat</span>
            </Button>

            {/* Activity button */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <BarChart3 className="h-4 w-4" />
              <span className="sr-only">Activity</span>
            </Button>

            {/* Send/Stop button */}
            {isStreaming ? (
              <Button
                type="button"
                onClick={onStop}
                variant="destructive"
                size="icon"
                className="h-8 w-8 rounded-full"
              >
                <Square className="h-3.5 w-3.5" />
                <span className="sr-only">Stop generation</span>
              </Button>
            ) : (
              <Button
                type="submit"
                onClick={handleSubmit}
                disabled={disabled}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full",
                  disabled && "pointer-events-none opacity-50"
                )}
              >
                <ArrowUp className="h-4 w-4" />
                <span className="sr-only">Send message</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

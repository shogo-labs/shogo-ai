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
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  ArrowUp,
  Plus,
  Square,
  X,
  BarChart3,
  Sparkles,
} from "lucide-react"

// Maximum file size in bytes (4MB)
const MAX_IMAGE_SIZE = 4 * 1024 * 1024
// Maximum number of images that can be attached
const MAX_IMAGES = 10

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
  onSubmit: (content: string, imageData?: string | string[]) => void
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

  // Image attachment state - support multiple images
  // Store images with unique IDs for better key management
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; dataUrl: string }>>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  
  // Use ref to track current images for sequential processing
  const pendingImagesRef = useRef<Array<{ id: string; dataUrl: string }>>([])
  
  // Sync ref with state
  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

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
   * Auto-resize textarea based on content
   */
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto'
    
    // Set height based on scrollHeight, respecting min/max constraints
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 60), 200)
    textarea.style.height = `${newHeight}px`
  }, [])

  /**
   * Generate a unique ID from a data URL
   * Uses a hash of the entire data URL to ensure uniqueness
   * Same image will get same ID (for duplicate detection), different images get different IDs
   */
  const generateImageId = useCallback((dataUrl: string): string => {
    // Hash the entire data URL to ensure each unique image gets a unique ID
    // This prevents false positives when different images have the same prefix
    // Same image will always produce the same hash (for duplicate detection)
    let hash = 0
    // Use a larger sample for better uniqueness, but not the entire URL for performance
    // Sample from beginning, middle, and end to capture image uniqueness
    const sampleSize = Math.min(dataUrl.length, 10000) // Sample up to 10k chars
    const step = Math.max(1, Math.floor(dataUrl.length / sampleSize))
    
    for (let i = 0; i < dataUrl.length; i += step) {
      const char = dataUrl.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    
    // Also include length to differentiate images of different sizes
    hash = ((hash << 5) - hash) + dataUrl.length
    hash = hash & hash
    
    return `img-${Math.abs(hash)}-${dataUrl.length}`
  }, [])

  /**
   * Process an image file and convert to base64 data URL
   * Appends to the existing images array instead of replacing
   * Includes deduplication check
   */
  const processImageFile = useCallback((file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Validate file size
      if (file.size > MAX_IMAGE_SIZE) {
        const error = `Image "${file.name}" must be smaller than 4MB (current: ${(file.size / 1024 / 1024).toFixed(1)}MB)`
        reject(new Error(error))
        return
      }

      // Validate file type
      if (!file.type.startsWith("image/")) {
        const error = `"${file.name}" is not an image file. Only image files are supported.`
        reject(new Error(error))
        return
      }

      // Read file as data URL
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const imageId = generateImageId(dataUrl)
        
        // Check for duplicates
        setPendingImages((prev) => {
          const isDuplicate = prev.some((img) => img.id === imageId)
          if (isDuplicate) {
            reject(new Error(`Image "${file.name}" is already attached`))
            return prev
          }
          
          // Check max limit
          if (prev.length >= MAX_IMAGES) {
            reject(new Error(`Maximum ${MAX_IMAGES} images allowed. Please remove some images first.`))
            return prev
          }
          
          return [...prev, { id: imageId, dataUrl }]
        })
        resolve()
      }
      reader.onerror = () => {
        reject(new Error(`Failed to read image file "${file.name}"`))
      }
      reader.readAsDataURL(file)
    })
  }, [generateImageId])

  /**
   * Handle paste events to capture images from clipboard
   */
  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Look for image items in clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault() // Prevent default paste behavior for images
          setIsProcessingImages(true)
          setImageError(null)
          
          try {
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

            // Check current pending images count
            setPendingImages((prev) => {
              if (prev.length >= MAX_IMAGES) {
                setImageError(`Maximum ${MAX_IMAGES} images allowed. Please remove some images first.`)
                return prev
              }
              return prev
            })

            // Read file as data URL
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => {
                resolve(reader.result as string)
              }
              reader.onerror = () => {
                reject(new Error("Failed to read image file"))
              }
              reader.readAsDataURL(file)
            })

            // Add to pending images
            const imageId = generateImageId(dataUrl)
            setPendingImages((prev) => {
              const isDuplicate = prev.some((img) => img.id === imageId)
              if (isDuplicate) {
                setImageError("Image is already attached")
                return prev
              }
              
              if (prev.length >= MAX_IMAGES) {
                setImageError(`Maximum ${MAX_IMAGES} images allowed. Please remove some images first.`)
                return prev
              }
              
              return [...prev, { id: imageId, dataUrl }]
            })
          } catch (error) {
            setImageError(error instanceof Error ? error.message : "Failed to process image")
          } finally {
            setIsProcessingImages(false)
          }
          return
        }
      }
    }
    // For non-image content, let the default paste behavior handle it
  }, [generateImageId])

  /**
   * Process dropped files - shared logic for both file input and drag-drop
   */
  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return

    setIsProcessingImages(true)
    setImageError(null)

    const errors: string[] = []
    const newImages: Array<{ id: string; dataUrl: string }> = []

    // Process all files and collect valid images, then update state once
    for (const file of fileArray) {
      try {
        // Validate file size
        if (file.size > MAX_IMAGE_SIZE) {
          errors.push(`Image "${file.name}" must be smaller than 4MB (current: ${(file.size / 1024 / 1024).toFixed(1)}MB)`)
          continue
        }

        // Validate file type
        if (!file.type.startsWith("image/")) {
          errors.push(`"${file.name}" is not an image file. Only image files are supported.`)
          continue
        }

        // Read file as data URL
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            resolve(reader.result as string)
          }
          reader.onerror = () => {
            reject(new Error(`Failed to read image file "${file.name}"`))
          }
          reader.readAsDataURL(file)
        })

        // Generate ID and check for duplicates
        const imageId = generateImageId(dataUrl)
        
        // Check against already processed images in this batch (by data URL, not just ID)
        const isDuplicateInBatch = newImages.some((img) => img.dataUrl === dataUrl)
        if (isDuplicateInBatch) {
          errors.push(`Image "${file.name}" is already being added`)
          continue
        }

        // Check against current pending images using ref (by data URL for accuracy)
        const currentImages = pendingImagesRef.current
        const isDuplicateInPending = currentImages.some((img) => img.dataUrl === dataUrl)
        if (isDuplicateInPending) {
          errors.push(`Image "${file.name}" is already attached`)
          continue
        }
        
        // Check max limit
        const totalCount = currentImages.length + newImages.length
        if (totalCount >= MAX_IMAGES) {
          errors.push(`Maximum ${MAX_IMAGES} images allowed. Please remove some images first.`)
          continue
        }

        // Add to new images batch
        newImages.push({ id: imageId, dataUrl })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Failed to process "${file.name}"`)
      }
    }

    // Update state once with all new images (single state update to avoid race conditions)
    if (newImages.length > 0) {
      setPendingImages((prev) => [...prev, ...newImages])
    }

    // Show errors if any
    if (errors.length > 0) {
      if (errors.length === 1) {
        setImageError(errors[0])
      } else {
        setImageError(`${errors.length} errors: ${errors.join('; ')}`)
      }
    }

    setIsProcessingImages(false)
  }, [generateImageId])

  /**
   * Handle file input change - support multiple file selection
   * Improved error handling to collect all errors
   * Processes files sequentially to avoid race conditions with duplicate detection
   */
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    await processFiles(files)

    // Reset file input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [processFiles])

  /**
   * Open file picker
   */
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  /**
   * Handle drag and drop events
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) {
      setIsDragging(true)
    }
  }, [isDragging])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragging to false if we're leaving the container itself
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      await processFiles(files)
    }
  }, [processFiles])

  /**
   * Remove a specific attached image by ID
   */
  const handleRemoveImage = useCallback((imageId: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== imageId))
    setImageError(null)
  }, [])

  /**
   * Handle input changes to detect slash commands and auto-resize
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
      
      // Auto-resize textarea
      resizeTextarea()
    },
    [resizeTextarea]
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
    if ((!trimmedContent && pendingImages.length === 0) || disabled || isProcessingImages) return

    // Always pass array format for consistency (even if empty or single item)
    const imageData = pendingImages.length > 0 
      ? pendingImages.map((img) => img.dataUrl)
      : undefined

    onSubmit(trimmedContent, imageData)
    textarea.value = ""
    setPendingImages([])
    setImageError(null)

    // Focus textarea after submit
    textarea.focus()
    
    // Reset textarea height after clearing
    resizeTextarea()
  }, [disabled, onSubmit, pendingImages, resizeTextarea, isProcessingImages])

  /**
   * Resize textarea on mount and when dependencies change
   */
  useEffect(() => {
    resizeTextarea()
  }, [resizeTextarea])

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
      {/* Image previews - shown above the input container */}
      {pendingImages.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pendingImages.map((image, index) => (
            <div
              key={image.id}
              data-testid="image-preview"
              className="relative inline-block max-w-[200px]"
            >
              <img
                src={image.dataUrl}
                alt={`Attached image ${index + 1}`}
                className="max-h-[100px] rounded-lg border border-border object-cover"
              />
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -right-2 -top-2 h-6 w-6"
                onClick={() => handleRemoveImage(image.id)}
                data-testid="remove-image-button"
                disabled={isProcessingImages}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Remove image</span>
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Loading indicator while processing images */}
      {isProcessingImages && (
        <div className="text-xs text-muted-foreground mb-2" data-testid="image-processing">
          Processing images...
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
      <div 
        className={cn(
          "relative rounded-xl border border-border/60 bg-muted/30 overflow-hidden",
          isDragging && "border-primary ring-2 ring-primary/20"
        )}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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

        {/* Hidden file input - allow multiple selection */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Textarea - clean, borderless, auto-expanding */}
        <Textarea
          ref={textareaRef}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "min-h-[60px] max-h-[200px] resize-none w-full overflow-y-auto",
            "border-0 bg-transparent shadow-none focus-visible:ring-0",
            "px-4 pt-4 pb-2 text-xs",
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
              disabled={disabled || isProcessingImages || pendingImages.length >= MAX_IMAGES}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
              data-testid="attach-image-button"
              title={pendingImages.length >= MAX_IMAGES ? `Maximum ${MAX_IMAGES} images allowed` : "Attach image"}
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
                disabled={disabled || isProcessingImages}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full",
                  (disabled || isProcessingImages) && "pointer-events-none opacity-50"
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

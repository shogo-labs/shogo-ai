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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ArrowUp,
  Plus,
  Square,
  X,
  Zap,
  Rocket,
  Lock,
  Crown,
  File,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronUp,
  Trash2,
  ArrowLeft,
} from "lucide-react"

// Agent mode configuration
export type AgentMode = "basic" | "advanced"

export interface AgentModeConfig {
  id: AgentMode
  label: string
  description: string
  icon: React.ReactNode
  creditHint: string
  /** Whether this mode requires a Pro subscription */
  requiresPro?: boolean
}

// Maximum file size in bytes (10MB for all files)
const MAX_FILE_SIZE = 10 * 1024 * 1024
// Maximum number of files that can be attached
const MAX_FILES = 10

// File attachment type
interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

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

// Agent mode options
// Credit pricing: Haiku ~0.025/5k tokens (min 0.2), Sonnet ~0.1/5k tokens (min 0.5)
const AGENT_MODES: AgentModeConfig[] = [
  {
    id: "basic",
    label: "Basic",
    description: "Fast responses, 4x cheaper",
    icon: <Zap className="h-3.5 w-3.5" />,
    creditHint: "~0.2 credits",
    requiresPro: false,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "More capable, better quality",
    icon: <Rocket className="h-3.5 w-3.5" />,
    creditHint: "~0.5-1 credits",
    requiresPro: true,
  },
]

export type QueuedMessage = {
  id: string
  content: string
  imageData?: string[]
  selectedAgentMode?: AgentMode
}

export interface ChatInputProps {
  onSubmit: (content: string, imageData?: string | string[], agentMode?: AgentMode) => void
  disabled?: boolean
  placeholder?: string
  /** Whether a stream is currently in progress */
  isStreaming?: boolean
  /** Callback to stop the current stream */
  onStop?: () => void
  /** Current agent mode */
  agentMode?: AgentMode
  /** Callback when agent mode changes */
  onAgentModeChange?: (mode: AgentMode) => void
  /** Whether user has an active Pro subscription */
  isPro?: boolean
  /** Callback when user clicks upgrade (for locked features) */
  onUpgradeClick?: () => void
  /** Queued messages waiting to be sent */
  queuedMessages?: QueuedMessage[]
  /** Callback to send a queued message immediately (skip queue) */
  onSendQueuedMessageNow?: (messageId: string) => void
  /** Callback to remove a message from queue */
  onRemoveQueuedMessage?: (messageId: string) => void
  /** Callback to reorder queued messages */
  onReorderQueuedMessage?: (messageId: string, direction: 'up' | 'down') => void
}

export function ChatInput({
  onSubmit,
  disabled = false,
  placeholder = "Ask Shogo...",
  isStreaming = false,
  onStop,
  agentMode: controlledAgentMode,
  onAgentModeChange,
  isPro = false,
  onUpgradeClick,
  queuedMessages = [],
  onSendQueuedMessageNow,
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // File attachment state - support multiple files
  // Store files with unique IDs and metadata for better key management
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [isProcessingFiles, setIsProcessingFiles] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState(true)
  
  // Use ref to track current files for sequential processing
  const pendingFilesRef = useRef<AttachedFile[]>([])
  
  // Sync ref with state
  useEffect(() => {
    pendingFilesRef.current = pendingFiles
  }, [pendingFiles])

  // Agent mode state (controlled or uncontrolled)
  // Default to "basic" for free users, "advanced" for Pro users
  const [internalAgentMode, setInternalAgentMode] = useState<AgentMode>(isPro ? "advanced" : "basic")
  const agentMode = controlledAgentMode ?? internalAgentMode
  
  const handleAgentModeChange = useCallback((mode: AgentMode) => {
    const modeConfig = AGENT_MODES.find((m) => m.id === mode)
    
    // Check if mode requires Pro and user isn't Pro
    if (modeConfig?.requiresPro && !isPro) {
      // Trigger upgrade flow instead of changing mode
      onUpgradeClick?.()
      return
    }
    
    if (onAgentModeChange) {
      onAgentModeChange(mode)
    } else {
      setInternalAgentMode(mode)
    }
  }, [onAgentModeChange, isPro, onUpgradeClick])

  // Get current agent mode config
  const currentAgentConfig = useMemo(() => 
    AGENT_MODES.find(m => m.id === agentMode) || AGENT_MODES[1],
    [agentMode]
  )

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
   * Generate a unique ID from a file
   * Uses file name, size, and last modified for uniqueness
   */
  const generateFileId = useCallback((file: File, dataUrl: string): string => {
    // Use file name, size, and last modified for uniqueness
    let hash = 0
    const str = `${file.name}-${file.size}-${file.lastModified}`
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    
    return `file-${Math.abs(hash)}-${file.size}`
  }, [])

  /**
   * Format file size for display
   */
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [])

  /**
   * Handle paste events to capture images from clipboard
   * Note: Only images can be pasted from clipboard, other files need to be selected via file picker
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
          setIsProcessingFiles(true)
          setFileError(null)
          
          try {
            // Validate file size
            if (file.size > MAX_FILE_SIZE) {
              setFileError(`File must be smaller than ${formatFileSize(MAX_FILE_SIZE)} (current: ${formatFileSize(file.size)})`)
              return
            }

            // Check current pending files count
            setPendingFiles((prev) => {
              if (prev.length >= MAX_FILES) {
                setFileError(`Maximum ${MAX_FILES} files allowed. Please remove some files first.`)
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
                reject(new Error("Failed to read file"))
              }
              reader.readAsDataURL(file)
            })

            // Add to pending files
            const fileId = generateFileId(file, dataUrl)
            setPendingFiles((prev) => {
              const isDuplicate = prev.some((f) => f.name === file.name && f.size === file.size)
              if (isDuplicate) {
                setFileError("File is already attached")
                return prev
              }
              
              if (prev.length >= MAX_FILES) {
                setFileError(`Maximum ${MAX_FILES} files allowed. Please remove some files first.`)
                return prev
              }
              
              return [...prev, {
                id: fileId,
                dataUrl,
                name: file.name,
                type: file.type || "image/png",
                size: file.size,
              }]
            })
          } catch (error) {
            setFileError(error instanceof Error ? error.message : "Failed to process file")
          } finally {
            setIsProcessingFiles(false)
          }
          return
        }
      }
    }
    // For non-image content, let the default paste behavior handle it
  }, [generateFileId, formatFileSize])

  /**
   * Process dropped files - shared logic for both file input and drag-drop
   */
  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return

    setIsProcessingFiles(true)
    setFileError(null)

    const errors: string[] = []
    const newFiles: AttachedFile[] = []

    // Process all files and collect valid files, then update state once
    for (const file of fileArray) {
      try {
        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`File "${file.name}" must be smaller than ${formatFileSize(MAX_FILE_SIZE)} (current: ${formatFileSize(file.size)})`)
          continue
        }

        // Read file as data URL
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            resolve(reader.result as string)
          }
          reader.onerror = () => {
            reject(new Error(`Failed to read file "${file.name}"`))
          }
          reader.readAsDataURL(file)
        })

        // Generate ID and check for duplicates
        const fileId = generateFileId(file, dataUrl)
        
        // Check against already processed files in this batch (by name and size)
        const isDuplicateInBatch = newFiles.some((f) => f.name === file.name && f.size === file.size)
        if (isDuplicateInBatch) {
          errors.push(`File "${file.name}" is already being added`)
          continue
        }

        // Check against current pending files using ref
        const currentFiles = pendingFilesRef.current
        const isDuplicateInPending = currentFiles.some((f) => f.name === file.name && f.size === file.size)
        if (isDuplicateInPending) {
          errors.push(`File "${file.name}" is already attached`)
          continue
        }
        
        // Check max limit
        const totalCount = currentFiles.length + newFiles.length
        if (totalCount >= MAX_FILES) {
          errors.push(`Maximum ${MAX_FILES} files allowed. Please remove some files first.`)
          continue
        }

        // Add to new files batch
        newFiles.push({
          id: fileId,
          dataUrl,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
        })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Failed to process "${file.name}"`)
      }
    }

    // Update state once with all new files (single state update to avoid race conditions)
    if (newFiles.length > 0) {
      setPendingFiles((prev) => [...prev, ...newFiles])
    }

    // Show errors if any
    if (errors.length > 0) {
      if (errors.length === 1) {
        setFileError(errors[0])
      } else {
        setFileError(`${errors.length} errors: ${errors.join('; ')}`)
      }
    }

    setIsProcessingFiles(false)
  }, [generateFileId, formatFileSize])

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
   * Remove a specific attached file by ID
   */
  const handleRemoveFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== fileId))
    setFileError(null)
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
    if ((!trimmedContent && pendingFiles.length === 0) || disabled || isProcessingFiles) return

    // Always pass array format for consistency (even if empty or single item)
    const fileData = pendingFiles.length > 0 
      ? pendingFiles.map((f) => f.dataUrl)
      : undefined

    onSubmit(trimmedContent, fileData, agentMode)
    textarea.value = ""
    setPendingFiles([])
    setFileError(null)

    // Focus textarea after submit
    textarea.focus()
    
    // Reset textarea height after clearing
    resizeTextarea()
  }, [disabled, onSubmit, pendingFiles, resizeTextarea, isProcessingFiles, agentMode])

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

  /**
   * Get file icon based on file type
   */
  const getFileIcon = useCallback((fileType: string) => {
    if (fileType.startsWith("image/")) {
      return <ImageIcon className="h-4 w-4" />
    }
    if (fileType.includes("pdf") || fileType.includes("document") || fileType.includes("text")) {
      return <FileText className="h-4 w-4" />
    }
    return <File className="h-4 w-4" />
  }, [])

  return (
    <div className="p-3">
      {/* File previews - shown above the input container */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pendingFiles.map((file) => {
            const isImage = file.type.startsWith("image/")
            return (
              <div
                key={file.id}
                data-testid="file-preview"
                className={cn(
                  "relative rounded-lg border border-border bg-muted/50 p-2",
                  isImage ? "max-w-[200px]" : "min-w-[150px] max-w-[250px]"
                )}
              >
                {isImage ? (
                  <img
                    src={file.dataUrl}
                    alt={file.name}
                    className="max-h-[100px] rounded border border-border object-cover w-full"
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-shrink-0 text-muted-foreground">
                      {getFileIcon(file.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate" title={file.name}>
                        {file.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute -right-2 -top-2 h-6 w-6"
                  onClick={() => handleRemoveFile(file.id)}
                  data-testid="remove-file-button"
                  disabled={isProcessingFiles}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove file</span>
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {/* Loading indicator while processing files */}
      {isProcessingFiles && (
        <div className="text-xs text-muted-foreground mb-2" data-testid="file-processing">
          Processing files...
        </div>
      )}

      {/* Error message */}
      {fileError && (
        <div
          data-testid="file-error"
          className="text-sm text-destructive mb-2"
        >
          {fileError}
        </div>
      )}

      {/* Queued messages section - Cursor style */}
      {queuedMessages.length > 0 && (
        <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
          <button
            type="button"
            onClick={() => setQueueExpanded((prev) => !prev)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  !queueExpanded && "-rotate-90"
                )}
              />
              <span className="font-medium">{queuedMessages.length} Queued</span>
            </div>
          </button>
          {queueExpanded && (
            <div className="border-t border-border/60">
              {queuedMessages.map((msg, index) => (
                <div
                  key={msg.id}
                  className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 border-b border-border/40 last:border-b-0"
                >
                  <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground truncate">
                      {msg.content || (msg.imageData && msg.imageData.length > 0 ? `${msg.imageData.length} image(s)` : 'Empty message')}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5">
                    {onSendQueuedMessageNow && (
                      <button
                        type="button"
                        onClick={() => onSendQueuedMessageNow(msg.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title="Send now"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        <span>to send now</span>
                      </button>
                    )}
                    {onReorderQueuedMessage && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => onReorderQueuedMessage(msg.id, 'up')}
                          disabled={index === 0}
                          title="Move up"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => onReorderQueuedMessage(msg.id, 'down')}
                          disabled={index === queuedMessages.length - 1}
                          title="Move down"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                    {onRemoveQueuedMessage && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => onRemoveQueuedMessage(msg.id)}
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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

        {/* Hidden file input - allow multiple selection, all file types */}
        <input
          ref={fileInputRef}
          type="file"
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
            "border-0 bg-transparent shadow-none !ring-0 !ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus-visible:outline-none focus-visible:border-0 focus:!ring-0 focus:!ring-offset-0 focus:outline-none focus:border-0 outline-none",
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
              disabled={disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES}
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
              data-testid="attach-file-button"
              title={pendingFiles.length >= MAX_FILES ? `Maximum ${MAX_FILES} files allowed` : "Attach file"}
            >
              <Plus className="h-4 w-4" />
              <span className="sr-only">Attach</span>
            </Button>

            {/* Agent mode selector */}
            <Select
              value={agentMode}
              onValueChange={(value) => handleAgentModeChange(value as AgentMode)}
              disabled={disabled || isStreaming}
            >
              <SelectTrigger 
                className="h-8 w-auto gap-1.5 rounded-full border-0 bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted px-3 shadow-none focus:ring-0"
                data-testid="agent-mode-selector"
              >
                {currentAgentConfig.icon}
                <span className="text-xs">{currentAgentConfig.label}</span>
              </SelectTrigger>
              <SelectContent align="start">
                {AGENT_MODES.map((mode) => {
                  const isLocked = mode.requiresPro && !isPro
                  return (
                    <SelectItem 
                      key={mode.id} 
                      value={mode.id}
                      className={cn(
                        "cursor-pointer",
                        isLocked && "opacity-80"
                      )}
                      data-testid={`agent-mode-option-${mode.id}`}
                    >
                      <div className="flex items-center gap-2">
                        {isLocked ? (
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          mode.icon
                        )}
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{mode.label}</span>
                            {mode.requiresPro && (
                              <span className={cn(
                                "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
                                isPro 
                                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" 
                                  : "bg-muted text-muted-foreground"
                              )}>
                                <Crown className="h-2.5 w-2.5" />
                                PRO
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {isLocked ? "Upgrade to unlock" : `${mode.description} (${mode.creditHint})`}
                          </div>
                        </div>
                      </div>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Right side buttons */}
          <div className="flex items-center gap-1">
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
                disabled={disabled || isProcessingFiles}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full",
                  (disabled || isProcessingFiles) && "pointer-events-none opacity-50"
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

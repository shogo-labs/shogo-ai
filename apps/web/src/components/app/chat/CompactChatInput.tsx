/**
 * CompactChatInput - Homepage-styled chat input for ChatPanel compact mode
 *
 * Matches the visual styling of the original HomePage input card:
 * - Translucent card with backdrop blur
 * - Attach/Theme buttons on left, Chat/Send buttons on right
 * - min-h-[80px] textarea with custom placeholder styling
 *
 * Used when ChatPanel is in mode="compact" on the homepage.
 * Supports file attachments (images, documents, etc.) via file picker.
 */

import { useState, useRef, useCallback, forwardRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Paperclip, Send, Loader2, X, File, FileText, Image as ImageIcon } from "lucide-react"
import { ThemeSelector } from "@/components/app/shared/ThemeSelector"

export type ProjectType = "APP" | "AGENT"

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

export interface CompactChatInputProps {
  /** Callback when user submits a prompt */
  onSubmit: (prompt: string, imageData?: string[]) => void
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
      placeholder: placeholderProp,
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

    // File attachment state
    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const [isProcessingFiles, setIsProcessingFiles] = useState(false)
    const [isDragging, setIsDragging] = useState(false)

    // Use ref to track current files for sequential processing
    const pendingFilesRef = useRef<AttachedFile[]>([])
    
    // Sync ref with state
    useEffect(() => {
      pendingFilesRef.current = pendingFiles
    }, [pendingFiles])

    // Use controlled or uncontrolled value
    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue

    const placeholder = placeholderProp ?? "Describe the agent you want to build..."

    /**
     * Generate a unique ID from a file
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
     * Process dropped files - shared logic for file input
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

      // Update state once with all new files
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
     * Handle file input change
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

    const handleSubmit = useCallback(() => {
      const trimmedContent = value.trim()
      if ((!trimmedContent && pendingFiles.length === 0) || disabled || isLoading || isProcessingFiles) return

      // Pass file data as array of data URLs
      const fileData = pendingFiles.length > 0 
        ? pendingFiles.map((f) => f.dataUrl)
        : undefined

      onSubmit(trimmedContent, fileData)
      
      // Don't clear files or text - the component will unmount on navigation.
      // Clearing them immediately causes the image previews to flash away
      // before the user is redirected to the project page.
    }, [value, disabled, isLoading, onSubmit, pendingFiles, isProcessingFiles])

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          handleSubmit()
        }
      },
      [handleSubmit]
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
      <div ref={ref} className={cn("w-full", className)}>
        <div 
          className={cn(
            "bg-card/80 backdrop-blur-sm border border-border rounded-xl shadow-lg overflow-hidden",
            isDragging && "border-primary ring-2 ring-primary/20"
          )}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* File previews - shown above the input area */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 p-4 pb-2">
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
            <div className="text-xs text-muted-foreground px-4 pb-2" data-testid="file-processing">
              Processing files...
            </div>
          )}

          {/* Error message */}
          {fileError && (
            <div
              data-testid="file-error"
              className="text-sm text-destructive px-4 pb-2"
            >
              {fileError}
            </div>
          )}

          {/* Input area */}
          <div className="p-4">
            {/* Hidden file input - allow multiple selection, all file types */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />

            <Textarea
              ref={textareaRef}
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled || isLoading}
              className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-base !ring-0 !ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus-visible:outline-none focus-visible:border-0 focus:!ring-0 focus:!ring-offset-0 focus:outline-none focus:border-0 outline-none placeholder:text-muted-foreground/60"
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
                onClick={handleAttachClick}
                disabled={disabled || isLoading || isProcessingFiles || pendingFiles.length >= MAX_FILES}
                title={pendingFiles.length >= MAX_FILES ? `Maximum ${MAX_FILES} files allowed` : "Attach file"}
                data-testid="attach-file-button"
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
                disabled={(!value.trim() && pendingFiles.length === 0) || disabled || isLoading || isProcessingFiles}
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CompactChatInput Component (React Native)
 *
 * Chat input card with attach button and send button.
 * Supports file attachments.
 *
 * Note: ThemeSelector is omitted for mobile (web-only feature).
 * Web (including mobile-web): hidden <input type="file" /> triggered by button click.
 * Native (Android/iOS dev-client): AttachSourceSheet + ImagePicker + DocumentPicker.
 * Drag-and-drop is omitted (not available on mobile).
 */

import { useState, useRef, useCallback, forwardRef, useEffect, useMemo } from "react"
import { View, Text, TextInput, Pressable, Image, ScrollView, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import {
  Paperclip,
  Send,
  Loader2,
  X,
  File,
  FileText,
  ImageIcon,
  ChevronDown,
} from "lucide-react-native"
import {
  INTERACTION_MODES,
  type FileAttachment,
  type InteractionMode,
} from "./ChatInput"
import { AttachSourceSheet } from "./AttachSourceSheet"

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export interface CompactChatInputProps {
  onSubmit: (prompt: string, files?: FileAttachment[]) => void
  disabled?: boolean
  isLoading?: boolean
  placeholder?: string
  className?: string
  value?: string
  onChange?: (value: string) => void
  interactionMode?: InteractionMode
  onInteractionModeChange?: (mode: InteractionMode) => void
}

export const CompactChatInput = forwardRef<View, CompactChatInputProps>(
  function CompactChatInput(
    {
      onSubmit,
      disabled = false,
      isLoading = false,
      placeholder: placeholderProp,
      className,
      value: controlledValue,
      onChange: controlledOnChange,
      interactionMode: controlledInteractionMode,
      onInteractionModeChange,
    },
    ref
  ) {
    const [internalValue, setInternalValue] = useState("")
    const textInputRef = useRef<TextInput>(null)

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const [attachSheetOpen, setAttachSheetOpen] = useState(false)
    const [interactionModeOpen, setInteractionModeOpen] = useState(false)
    const [internalInteractionMode, setInternalInteractionMode] =
      useState<InteractionMode>("agent")
    const interactionMode = controlledInteractionMode ?? internalInteractionMode

    const handleInteractionModeChange = useCallback(
      (mode: InteractionMode) => {
        if (onInteractionModeChange) {
          onInteractionModeChange(mode)
        } else {
          setInternalInteractionMode(mode)
        }
      },
      [onInteractionModeChange]
    )

    const currentInteractionConfig = useMemo(
      () => INTERACTION_MODES.find((m) => m.id === interactionMode) || INTERACTION_MODES[0],
      [interactionMode]
    )
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const dropZoneRef = useRef<View>(null)

    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue

    const placeholderText =
      placeholderProp ??
      (interactionMode === "plan"
        ? "Describe what you want to plan..."
        : interactionMode === "ask"
          ? "Ask a question..."
          : "Describe the agent you want to build...")

    const formatFileSize = useCallback((bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }, [])

    const handleRemoveFile = useCallback((fileId: string) => {
      setPendingFiles((prev) => prev.filter((f) => f.id !== fileId))
      setFileError(null)
    }, [])

    const handleSubmit = useCallback(() => {
      const trimmedContent = value.trim()
      if ((!trimmedContent && pendingFiles.length === 0) || disabled || isLoading) return

      const fileData: FileAttachment[] | undefined =
        pendingFiles.length > 0
          ? pendingFiles.map((f) => ({ dataUrl: f.dataUrl, name: f.name, type: f.type }))
          : undefined

      onSubmit(trimmedContent, fileData)
      setFileError(null)
    }, [value, disabled, isLoading, onSubmit, pendingFiles])

    const handleAttachClick = useCallback(() => {
      if (Platform.OS === "web") {
        fileInputRef.current?.click()
        return
      }
      setAttachSheetOpen(true)
    }, [])

    const processFiles = useCallback((files: FileList | File[]) => {
      Array.from(files).forEach((file: File) => {
        if (file.size > MAX_FILE_SIZE) {
          setFileError(`File "${file.name}" exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`)
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          setPendingFiles((prev) => {
            if (prev.length >= MAX_FILES) {
              setFileError(`Maximum ${MAX_FILES} files allowed`)
              return prev
            }
            setFileError(null)
            return [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                dataUrl,
                name: file.name,
                type: file.type,
                size: file.size,
              },
            ]
          })
        }
        reader.readAsDataURL(file)
      })
    }, [])

    const handleWebFileChange = useCallback(
      (e: any) => {
        const files = e.target?.files
        if (!files || files.length === 0) return
        processFiles(files)
        if (e.target) e.target.value = ""
      },
      [processFiles]
    )

    useEffect(() => {
      if (Platform.OS !== "web") return
      const node = dropZoneRef.current as unknown as HTMLElement | null
      if (!node) return

      const handleDragOver = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }
      const handleDrop = (e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer?.files?.length) {
          processFiles(Array.from(e.dataTransfer.files) as any)
        }
      }

      node.addEventListener("dragover", handleDragOver)
      node.addEventListener("drop", handleDrop)
      return () => {
        node.removeEventListener("dragover", handleDragOver)
        node.removeEventListener("drop", handleDrop)
      }
    }, [processFiles])

    const getFileIcon = useCallback((fileType: string) => {
      if (fileType.startsWith("image/")) {
        return <ImageIcon className="h-4 w-4 text-gray-400" size={16} />
      }
      if (
        fileType.includes("pdf") ||
        fileType.includes("document") ||
        fileType.includes("text")
      ) {
        return <FileText className="h-4 w-4 text-gray-400" size={16} />
      }
      return <File className="h-4 w-4 text-gray-400" size={16} />
    }, [])

    return (
      <View ref={ref} className={cn("w-full", className)}>
        <View ref={dropZoneRef as any} className="bg-white/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          {/* Hidden file input for web (including mobile-web on Android/iOS browsers) */}
          {Platform.OS === "web" && (
            <input
              ref={fileInputRef as any}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.csv,.json"
              capture={undefined}
              onChange={handleWebFileChange}
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
          )}

          {/* File previews */}
          {pendingFiles.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 p-4 pb-2"
            >
              {pendingFiles.map((file) => {
                const isImage = file.type.startsWith("image/")
                return (
                  <View
                    key={file.id}
                    className={cn(
                      "relative rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100/50 dark:bg-gray-800/50 p-2",
                      isImage ? "w-[150px]" : "w-[180px]"
                    )}
                  >
                    {isImage ? (
                      <Image
                        source={{ uri: file.dataUrl }}
                        className="h-[80px] rounded border border-gray-200 dark:border-gray-700 w-full"
                        resizeMode="cover"
                      />
                    ) : (
                      <View className="flex-row items-center gap-2">
                        {getFileIcon(file.type)}
                        <View className="flex-1 min-w-0">
                          <Text
                            className="text-xs font-medium text-foreground"
                            numberOfLines={1}
                          >
                            {file.name}
                          </Text>
                          <Text className="text-xs text-gray-400">
                            {formatFileSize(file.size)}
                          </Text>
                        </View>
                      </View>
                    )}
                    <Pressable
                      onPress={() => handleRemoveFile(file.id)}
                      className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-red-500 items-center justify-center"
                    >
                      <X className="h-3 w-3 text-white" size={12} />
                    </Pressable>
                  </View>
                )
              })}
            </ScrollView>
          )}

          {/* Error message */}
          {fileError && (
            <Text className="text-sm text-red-500 px-4 pb-2">{fileError}</Text>
          )}

          {/* Input area */}
          <View className="px-4 pt-4 pb-1">
            <TextInput
              ref={textInputRef}
              placeholder={placeholderText}
              placeholderTextColor="#9ca3af"
              accessibilityLabel="Describe the agent you want to build"
              value={value}
              onChangeText={setValue}
              onSubmitEditing={handleSubmit}
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              editable={!disabled && !isLoading}
              multiline
              className={cn(
                "min-h-[80px] text-base text-foreground",
                Platform.OS === "web" && "outline-none"
              )}
              textAlignVertical="top"
            />
          </View>

          {/* Action bar */}
          <View className="px-4 pt-0 pb-1 flex-row items-center justify-between gap-2">
            <View className="flex-row items-center gap-1 flex-1 min-w-0">
              <Pressable
                onPress={handleAttachClick}
                disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
                role="button"
                accessibilityLabel="Attach file"
                className="min-h-11 min-w-11 flex-row items-center gap-1.5 rounded-lg px-3 py-2 active:opacity-70"
                android_ripple={{ color: "rgba(128,128,128,0.25)" }}
              >
                <Paperclip className="h-4 w-4 text-gray-400" size={16} />
                <Text className="text-xs text-gray-400">Attach</Text>
              </Pressable>

              <Popover
                placement="top"
                size="xs"
                isOpen={interactionModeOpen}
                onOpen={() => setInteractionModeOpen(true)}
                onClose={() => setInteractionModeOpen(false)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    disabled={disabled || isLoading}
                    className={cn(
                      "h-8 flex-row items-center gap-1 rounded-md px-2 max-w-[140px]",
                      interactionMode === "agent" && "bg-muted/50",
                      interactionMode === "plan" &&
                        "border border-amber-500/45 bg-amber-500/12",
                      interactionMode === "ask" &&
                        "border border-emerald-500/45 bg-emerald-500/12"
                    )}
                    testID="home-interaction-mode-trigger"
                  >
                    <currentInteractionConfig.Icon
                      className={cn(
                        "h-3 w-3 shrink-0",
                        interactionMode === "agent" && "text-muted-foreground",
                        interactionMode === "plan" && "text-amber-400",
                        interactionMode === "ask" && "text-emerald-400"
                      )}
                      size={12}
                    />
                    <Text
                      className={cn(
                        "text-xs shrink-0",
                        interactionMode === "agent" && "text-muted-foreground",
                        interactionMode === "plan" && "text-amber-400",
                        interactionMode === "ask" && "text-emerald-400"
                      )}
                      numberOfLines={1}
                    >
                      {currentInteractionConfig.label}
                    </Text>
                    <ChevronDown
                      className={cn(
                        "h-2.5 w-2.5 shrink-0",
                        interactionMode === "agent" && "text-muted-foreground/60",
                        interactionMode === "plan" && "text-amber-400/80",
                        interactionMode === "ask" && "text-emerald-400/80"
                      )}
                      size={10}
                    />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[280px] p-0">
                  <View className="py-1">
                    {INTERACTION_MODES.map((mode) => {
                      const isSelected = mode.id === interactionMode
                      return (
                        <Pressable
                          key={mode.id}
                          onPress={() => {
                            handleInteractionModeChange(mode.id)
                            setInteractionModeOpen(false)
                          }}
                          className={cn(
                            "flex-row items-center gap-3 p-3 rounded-lg mb-1",
                            isSelected &&
                              mode.id === "agent" &&
                              "bg-accent",
                            isSelected &&
                              mode.id === "plan" &&
                              "border border-amber-500/35 bg-amber-500/12",
                            isSelected &&
                              mode.id === "ask" &&
                              "border border-emerald-500/35 bg-emerald-500/12"
                          )}
                        >
                          <View className="w-8 items-center">
                            <mode.Icon
                              className={cn(
                                "h-3.5 w-3.5",
                                isSelected &&
                                  mode.id === "plan" &&
                                  "text-amber-400",
                                isSelected &&
                                  mode.id === "ask" &&
                                  "text-emerald-400",
                                (!isSelected || mode.id === "agent") &&
                                  "text-muted-foreground"
                              )}
                              size={14}
                            />
                          </View>
                          <View className="flex-1">
                            <Text
                              className={cn(
                                "font-medium text-sm",
                                isSelected &&
                                  mode.id === "plan" &&
                                  "text-amber-400",
                                isSelected &&
                                  mode.id === "ask" &&
                                  "text-emerald-400",
                                (!isSelected || mode.id === "agent") &&
                                  "text-foreground"
                              )}
                            >
                              {mode.label}
                            </Text>
                            <Text className="text-xs text-muted-foreground">
                              {mode.description}
                            </Text>
                          </View>
                        </Pressable>
                      )
                    })}
                  </View>
                </PopoverContent>
              </Popover>
            </View>

            <Pressable
              onPress={handleSubmit}
              disabled={(!value.trim() && pendingFiles.length === 0) || disabled || isLoading}
              role="button"
              accessibilityLabel="Send message"
              className={cn(
                "h-8 w-8 rounded-md items-center justify-center",
                (!value.trim() && pendingFiles.length === 0) || disabled || isLoading
                  ? "bg-gray-200 dark:bg-gray-700"
                  : "bg-primary"
              )}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 text-white" size={16} />
              ) : (
                <Send className="h-4 w-4 text-white" size={16} />
              )}
            </Pressable>
          </View>
        </View>

        {Platform.OS !== "web" && (
          <AttachSourceSheet
            open={attachSheetOpen}
            onOpenChange={setAttachSheetOpen}
            currentCount={pendingFiles.length}
            maxFiles={MAX_FILES}
            maxFileSizeBytes={MAX_FILE_SIZE}
            onFiles={(picked) => {
              setPendingFiles((prev) => {
                const room = MAX_FILES - prev.length
                if (room <= 0) return prev
                const added = picked.slice(0, room).map((f) => ({
                  id: f.id,
                  dataUrl: f.dataUrl,
                  name: f.name,
                  type: f.type,
                  size: f.size,
                }))
                if (picked.length > room) {
                  setFileError(`Maximum ${MAX_FILES} files allowed`)
                } else {
                  setFileError(null)
                }
                return [...prev, ...added]
              })
            }}
            onError={(message) => setFileError(message)}
          />
        )}
      </View>
    )
  }
)

export default CompactChatInput

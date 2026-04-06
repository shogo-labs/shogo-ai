// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CompactChatInput Component (React Native)
 *
 * Chat input card with attach button and send button.
 * Supports file attachments.
 * Styled to match ChatInput exactly (shared toolbar layout).
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
  ArrowUp,
  Plus,
  Loader2,
  X,
  File,
  FileText,
  ImageIcon,
  ChevronDown,
  Lock,
  Crown,
} from "lucide-react-native"
import {
  INTERACTION_MODES,
  AGENT_MODES,
  type FileAttachment,
  type InteractionMode,
  type AgentMode,
} from "./ChatInput"
import { usePlatformConfig } from "../../lib/platform-config"
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
  agentMode?: AgentMode
  onAgentModeChange?: (mode: AgentMode) => void
  isPro?: boolean
  onUpgradeClick?: () => void
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
      agentMode: controlledAgentMode,
      onAgentModeChange,
      isPro = false,
      onUpgradeClick,
    },
    ref
  ) {
    const { features } = usePlatformConfig()
    const effectiveIsPro = features.billing ? isPro : true

    const [internalValue, setInternalValue] = useState("")
    const textInputRef = useRef<TextInput>(null)

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const [attachSheetOpen, setAttachSheetOpen] = useState(false)
    const [interactionModeOpen, setInteractionModeOpen] = useState(false)
    const [agentModeOpen, setAgentModeOpen] = useState(false)
    const [internalInteractionMode, setInternalInteractionMode] =
      useState<InteractionMode>("agent")
    const interactionMode = controlledInteractionMode ?? internalInteractionMode

    const [internalAgentMode, setInternalAgentMode] = useState<AgentMode>(
      effectiveIsPro ? "advanced" : "basic"
    )
    const agentMode = controlledAgentMode ?? internalAgentMode

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

    const handleAgentModeChange = useCallback(
      (mode: AgentMode) => {
        const modeConfig = AGENT_MODES.find((m) => m.id === mode)

        if (modeConfig?.requiresPro && !effectiveIsPro) {
          onUpgradeClick?.()
          return
        }

        if (onAgentModeChange) {
          onAgentModeChange(mode)
        } else {
          setInternalAgentMode(mode)
        }
      },
      [onAgentModeChange, effectiveIsPro, onUpgradeClick]
    )

    const currentInteractionConfig = useMemo(
      () => INTERACTION_MODES.find((m) => m.id === interactionMode) || INTERACTION_MODES[0],
      [interactionMode]
    )

    const currentAgentConfig = useMemo(
      () => AGENT_MODES.find((m) => m.id === agentMode) || AGENT_MODES[1],
      [agentMode]
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
        return <ImageIcon className="h-4 w-4 text-muted-foreground" size={16} />
      }
      if (
        fileType.includes("pdf") ||
        fileType.includes("document") ||
        fileType.includes("text")
      ) {
        return <FileText className="h-4 w-4 text-muted-foreground" size={16} />
      }
      return <File className="h-4 w-4 text-muted-foreground" size={16} />
    }, [])

    return (
      <View ref={ref} className={cn("w-full", className)}>
        <View
          ref={dropZoneRef as any}
          className="relative rounded-xl border bg-card border-border/60 overflow-hidden"
        >
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
                      "relative rounded-lg border border-border bg-muted/50 p-2",
                      isImage ? "w-[150px]" : "w-[180px]"
                    )}
                  >
                    {isImage ? (
                      <Image
                        source={{ uri: file.dataUrl }}
                        className="h-[80px] rounded border border-border w-full"
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
                          <Text className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)}
                          </Text>
                        </View>
                      </View>
                    )}
                    <Pressable
                      onPress={() => handleRemoveFile(file.id)}
                      className="absolute -right-1 -top-1 h-6 w-6 rounded-full bg-destructive items-center justify-center"
                    >
                      <X className="h-3 w-3 text-destructive-foreground" size={12} />
                    </Pressable>
                  </View>
                )
              })}
            </ScrollView>
          )}

          {/* Error message */}
          {fileError && (
            <Text className="text-sm text-destructive px-4 pb-2">{fileError}</Text>
          )}

          {/* TextInput */}
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
            blurOnSubmit={false}
            className={cn(
              "min-h-[80px] max-h-[200px] w-full",
              "px-4 pt-4 text-xs text-foreground",
              disabled && "opacity-50",
              Platform.OS === "web" && "outline-none"
            )}
            textAlignVertical="top"
          />

          {/* Bottom toolbar */}
          <View className="flex-row items-center justify-between p-1.5">
            {/* Left side buttons */}
            <View className="flex-row items-center gap-1">
              {/* Interaction mode selector (Agent / Plan / Ask) */}
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
                      "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
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
                        "h-2.5 w-2.5",
                        interactionMode === "agent" && "text-muted-foreground",
                        interactionMode === "plan" && "text-amber-400",
                        interactionMode === "ask" && "text-emerald-400"
                      )}
                      size={10}
                    />
                    <Text
                      className={cn(
                        "text-xs",
                        interactionMode === "agent" && "text-muted-foreground",
                        interactionMode === "plan" && "text-amber-400",
                        interactionMode === "ask" && "text-emerald-400"
                      )}
                    >
                      {currentInteractionConfig.label}
                    </Text>
                    <ChevronDown
                      className={cn(
                        "h-2 w-2",
                        interactionMode === "agent" && "text-muted-foreground/60",
                        interactionMode === "plan" && "text-amber-400/80",
                        interactionMode === "ask" && "text-emerald-400/80"
                      )}
                      size={8}
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

              {/* Model quality selector (Basic / Advanced) */}
              <Popover
                placement="top"
                size="xs"
                isOpen={agentModeOpen}
                onOpen={() => setAgentModeOpen(true)}
                onClose={() => setAgentModeOpen(false)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    disabled={disabled || isLoading}
                    className="h-[22px] flex-row items-center gap-1 rounded-md px-1.5"
                  >
                    <Text className="text-xs text-muted-foreground">
                      {currentAgentConfig.label}
                    </Text>
                    <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[280px] p-0">
                  <View className="py-1">
                    {AGENT_MODES.map((mode) => {
                      const isLocked = mode.requiresPro && !effectiveIsPro
                      const isSelected = mode.id === agentMode
                      return (
                        <Pressable
                          key={mode.id}
                          onPress={() => {
                            handleAgentModeChange(mode.id)
                            setAgentModeOpen(false)
                          }}
                          className={cn(
                            "flex-row items-center gap-3 p-3 rounded-lg mb-1",
                            isSelected && "bg-accent"
                          )}
                        >
                          <View className="w-8 items-center">
                            {isLocked ? (
                              <Lock
                                className="h-4 w-4 text-muted-foreground"
                                size={16}
                              />
                            ) : (
                              <mode.Icon className="h-3.5 w-3.5 text-muted-foreground" size={14} />
                            )}
                          </View>
                          <View className="flex-1">
                            <View className="flex-row items-center gap-1.5">
                              <Text className="font-medium text-sm text-foreground">
                                {mode.label}
                              </Text>
                              {features.billing && mode.requiresPro && (
                                <View
                                  className={cn(
                                    "flex-row items-center gap-0.5 px-1.5 py-0.5 rounded-full",
                                    effectiveIsPro
                                      ? "bg-amber-100 dark:bg-amber-900/30"
                                      : "bg-muted"
                                  )}
                                >
                                  <Crown
                                    className={cn(
                                      "h-2.5 w-2.5",
                                      effectiveIsPro
                                        ? "text-amber-700 dark:text-amber-400"
                                        : "text-muted-foreground"
                                    )}
                                    size={10}
                                  />
                                  <Text
                                    className={cn(
                                      "text-[10px] font-semibold",
                                      effectiveIsPro
                                        ? "text-amber-700 dark:text-amber-400"
                                        : "text-muted-foreground"
                                    )}
                                  >
                                    PRO
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text className="text-xs text-muted-foreground">
                              {isLocked
                                ? "Upgrade to unlock"
                                : features.billing ? `${mode.description} (${mode.creditHint})` : mode.description}
                            </Text>
                          </View>
                        </Pressable>
                      )
                    })}
                  </View>
                </PopoverContent>
              </Popover>
            </View>

            {/* Right side buttons */}
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={handleAttachClick}
                disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
                role="button"
                accessibilityLabel="Attach file"
                className="min-h-5 min-w-5 rounded-full items-center justify-center active:opacity-70"
                android_ripple={{ color: "rgba(128,128,128,0.25)" }}
              >
                <Plus
                  className={cn(
                    "h-4 w-4",
                    disabled || isLoading || pendingFiles.length >= MAX_FILES
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground"
                  )}
                  size={12}
                />
              </Pressable>

              <Pressable
                onPress={handleSubmit}
                disabled={(!value.trim() && pendingFiles.length === 0) || disabled || isLoading}
                role="button"
                accessibilityLabel="Send message"
                className={cn(
                  "h-5 w-5 rounded-full items-center justify-center bg-primary",
                  ((!value.trim() && pendingFiles.length === 0) || disabled || isLoading) && "opacity-50"
                )}
              >
                {isLoading ? (
                  <Loader2 className="h-3 w-3 text-primary-foreground" size={12} />
                ) : (
                  <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
                )}
              </Pressable>
            </View>
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

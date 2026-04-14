// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatInput Component (React Native)
 * Migrated from apps/web/src/components/app/chat/ChatInput.tsx
 *
 * Lovable.dev-style chat input with:
 * - Rounded container with subtle border
 * - Clean TextInput with "Ask Shogo..." placeholder
 * - Bottom toolbar with action buttons
 * - Agent mode selector via popover dropdown
 *
 * Supports image attachments via file picker, drag-and-drop, and paste (web).
 * Native: Expo ImagePicker + DocumentPicker (AttachSourceSheet + native-attachment-picker).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  ScrollView,
  Platform,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { usePlatformConfig } from "../../lib/platform-config"
import { AttachSourceSheet } from "./AttachSourceSheet"
import { ContextTracker } from "./ContextTracker"
import {
  getModelsByProvider,
  getModelShortDisplayName,
  getModelTier,
  type ModelTier,
} from "@shogo/model-catalog"
import {
  ArrowUp,
  Plus,
  Square,
  X,
  Zap,
  Lock,
  File,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  ChevronUp,
  Trash2,
  Bot,
  ClipboardList,
  MessageCircleQuestion,
  Check,
  Mic,
} from "lucide-react-native"
import { useVoiceInput } from "./useVoiceInput"
import { VoiceWaveform } from "./VoiceWaveform"

export const DEFAULT_MODEL_PRO = "claude-sonnet-4-6"
export const DEFAULT_MODEL_FREE = "claude-haiku-4-5-20251001"

const MODEL_GROUPS = getModelsByProvider().map((g) => ({
  label: g.label,
  models: g.models.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    tier: e.tier as ModelTier,
  })),
}))

const TIER_LABELS: Record<ModelTier, string> = {
  premium: "Premium",
  standard: "Standard",
  economy: "Economy",
}

export type InteractionMode = "agent" | "plan" | "ask"

export interface InteractionModeConfig {
  id: InteractionMode
  label: string
  description: string
  Icon: React.ElementType
}

export const INTERACTION_MODES: InteractionModeConfig[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Full autonomous mode — reads, writes, executes",
    Icon: Bot,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Research and create a plan before making changes",
    Icon: ClipboardList,
  },
  {
    id: "ask",
    label: "Ask",
    description: "Just answer questions, no tools or changes",
    Icon: MessageCircleQuestion,
  },
]

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export interface FileAttachment {
  dataUrl: string
  name: string
  type: string
}


interface SkillOption {
  name: string
  description: string
}

const SKILLS: SkillOption[] = []

export type QueuedMessage = {
  id: string
  content: string
  files?: FileAttachment[]
  selectedModel?: string
}

export interface ChatInputProps {
  onSubmit: (content: string, files?: FileAttachment[], modelId?: string) => void
  disabled?: boolean
  placeholder?: string
  isStreaming?: boolean
  onStop?: () => void
  selectedModel?: string
  onModelChange?: (modelId: string) => void
  isPro?: boolean
  onUpgradeClick?: () => void
  queuedMessages?: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
  interactionMode?: InteractionMode
  onInteractionModeChange?: (mode: InteractionMode) => void
  contextUsage?: { inputTokens: number; contextWindowTokens: number } | null
  quickActions?: { label: string; prompt: string }[]
  onQuickActionClick?: (prompt: string) => void
}

export function ChatInput({
  onSubmit,
  disabled = false,
  placeholder = "Ask Shogo...",
  isStreaming = false,
  onStop,
  selectedModel: controlledModel,
  onModelChange,
  isPro = false,
  onUpgradeClick,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
  interactionMode: controlledInteractionMode,
  onInteractionModeChange,
  contextUsage,
  quickActions = [],
  onQuickActionClick,
}: ChatInputProps) {
  const { features } = usePlatformConfig()
  const effectiveIsPro = features.billing ? isPro : true

  const textInputRef = useRef<TextInput>(null)
  const dropZoneRef = useRef<View>(null)
  const dragCounterRef = useRef(0)

  const [inputValue, setInputValue] = useState("")
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [isProcessingFiles, setIsProcessingFiles] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState(true)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [interactionModeOpen, setInteractionModeOpen] = useState(false)
  const [attachSheetOpen, setAttachSheetOpen] = useState(false)

  const [internalModel, setInternalModel] = useState<string>(
    effectiveIsPro ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE
  )
  const currentModelId = controlledModel ?? internalModel

  const handleModelChange = useCallback(
    (modelId: string) => {
      const tier = getModelTier(modelId)
      if (tier !== "economy" && !effectiveIsPro) {
        onUpgradeClick?.()
        return
      }

      if (onModelChange) {
        onModelChange(modelId)
      } else {
        setInternalModel(modelId)
      }
    },
    [onModelChange, effectiveIsPro, onUpgradeClick]
  )

  const [internalInteractionMode, setInternalInteractionMode] = useState<InteractionMode>("agent")
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

  const [quickActionsOpen, setQuickActionsOpen] = useState(false)

  // Skill picker state
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [filterText, setFilterText] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filteredSkills = useMemo(() => {
    if (!filterText) return SKILLS
    const lower = filterText.toLowerCase()
    return SKILLS.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower)
    )
  }, [filterText])

  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [])

  const handleRemoveFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== fileId))
    setFileError(null)
  }, [])

  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  // Drag-and-drop support (web only)
  // Uses dragenter/dragleave counter to avoid flicker when cursor crosses child elements
  useEffect(() => {
    if (Platform.OS !== "web") return
    const node = dropZoneRef.current as unknown as HTMLElement | null
    if (!node) return

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      if (dragCounterRef.current === 1) {
        setIsDragOver(true)
      }
    }
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDragOver(false)
      }
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragOver(false)
      if (e.dataTransfer?.files?.length) {
        processFiles(Array.from(e.dataTransfer.files))
      }
    }

    node.addEventListener("dragover", handleDragOver)
    node.addEventListener("dragenter", handleDragEnter)
    node.addEventListener("dragleave", handleDragLeave)
    node.addEventListener("drop", handleDrop)
    return () => {
      node.removeEventListener("dragover", handleDragOver)
      node.removeEventListener("dragenter", handleDragEnter)
      node.removeEventListener("dragleave", handleDragLeave)
      node.removeEventListener("drop", handleDrop)
    }
  }, [processFiles])

  // Paste image support (web only)
  useEffect(() => {
    if (Platform.OS !== "web") return
    const node = dropZoneRef.current as unknown as HTMLElement | null
    if (!node) return

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        processFiles(imageFiles)
      }
    }

    node.addEventListener("paste", handlePaste as EventListener)
    return () => {
      node.removeEventListener("paste", handlePaste as EventListener)
    }
  }, [processFiles])

  const appendTranscriptToInput = useCallback((transcript: string) => {
    const normalized = transcript.trim()
    if (!normalized) return

    setInputValue((current) => {
      const prefix =
        current.length === 0 || /\s$/.test(current) ? current : `${current} `
      return `${prefix}${normalized}`
    })
    setShowSkillPicker(false)
    setFilterText("")
    setTimeout(() => textInputRef.current?.focus(), 0)
  }, [])

  const voiceInput = useVoiceInput({
    onTranscript: appendTranscriptToInput,
  })

  const selectSkill = useCallback(
    (skill: SkillOption) => {
      const spaceIndex = inputValue.indexOf(" ")
      const afterPrefix = spaceIndex === -1 ? "" : inputValue.slice(spaceIndex)
      setInputValue(`/${skill.name}${afterPrefix || " "}`)
      setShowSkillPicker(false)
      textInputRef.current?.focus()
    },
    [inputValue]
  )

  const handleSubmit = useCallback(() => {
    const trimmedContent = inputValue.trim()
    if (
      (!trimmedContent && pendingFiles.length === 0) ||
      disabled ||
      isProcessingFiles ||
      voiceInput.isBusy
    ) {
      return
    }

    const fileData: FileAttachment[] | undefined =
      pendingFiles.length > 0
        ? pendingFiles.map((f) => ({ dataUrl: f.dataUrl, name: f.name, type: f.type }))
        : undefined

    onSubmit(trimmedContent, fileData, currentModelId)
    setInputValue("")
    setPendingFiles([])
    setFileError(null)

    textInputRef.current?.focus()
  }, [disabled, onSubmit, pendingFiles, isProcessingFiles, currentModelId, inputValue, voiceInput.isBusy])

  const handleChangeText = useCallback(
    (text: string) => {
      setInputValue(text)

      if (text.startsWith("/") && !text.includes(" ")) {
        setShowSkillPicker(true)
        setFilterText(text.slice(1).toLowerCase())
        setSelectedIndex(0)
      } else {
        setShowSkillPicker(false)
      }
    },
    []
  )

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
    <View className="p-3 pt-0">
      {/* File previews */}
      {pendingFiles.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 mb-2"
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
                    <View className="flex-shrink-0">
                      {getFileIcon(file.type)}
                    </View>
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
                  disabled={isProcessingFiles}
                  className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-destructive items-center justify-center"
                >
                  <X className="h-4 w-4 text-destructive-foreground" size={16} />
                </Pressable>
              </View>
            )
          })}
        </ScrollView>
      )}

      {/* Processing indicator */}
      {isProcessingFiles && (
        <Text className="text-xs text-muted-foreground mb-2">
          Processing files...
        </Text>
      )}

      {/* Error message */}
      {fileError && (
        <Text className="text-sm text-destructive mb-2">{fileError}</Text>
      )}

      {voiceInput.error && (
        <Text className="text-sm text-destructive mb-2">{voiceInput.error}</Text>
      )}

      {/* Queued messages */}
      {queuedMessages.length > 0 && (
        <View className="rounded-t-lg border-x border-t border-border/60 bg-muted/30 overflow-hidden">
          <Pressable
            onPress={() => setQueueExpanded((prev) => !prev)}
            className="w-full flex-row items-center justify-between px-2 py-1"
          >
            <View className="flex-row items-center gap-2">
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground",
                  !queueExpanded && "-rotate-90"
                )}
                size={16}
              />
              <Text className="text-sm text-foreground">
                {queuedMessages.length} Queued
              </Text>
            </View>
          </Pressable>
          {queueExpanded && (
            <View className="border-t border-border/60">
              {queuedMessages.map((msg, index) => (
                <View
                  key={msg.id}
                  className="flex-row items-center gap-2 px-2 py-1.5 border-b border-border/40 last:border-b-0"
                >
                  <View className="h-3 w-3 rounded-full border border-muted-foreground/30 flex-shrink-0" />
                  <View className="flex-1 min-w-0">
                    <Text className="text-xs text-foreground" numberOfLines={1}>
                      {msg.content ||
                        (msg.files && msg.files.length > 0
                          ? `${msg.files.length} file(s)`
                          : "Empty message")}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-0.5">
                    {onReorderQueuedMessage && queuedMessages.length > 1 && (
                      <>
                        {index > 0 && (
                          <Pressable
                            onPress={() => onReorderQueuedMessage(msg.id, "up")}
                            className="h-6 w-6 items-center justify-center"
                          >
                            <ChevronUp
                              className="h-3 w-3 text-muted-foreground"
                              size={12}
                            />
                          </Pressable>
                        )}
                        {index < queuedMessages.length - 1 && (
                          <Pressable
                            onPress={() => onReorderQueuedMessage(msg.id, "down")}
                            className="h-6 w-6 items-center justify-center"
                          >
                            <ChevronDown
                              className="h-3 w-3 text-muted-foreground"
                              size={12}
                            />
                          </Pressable>
                        )}
                      </>
                    )}
                    {onRemoveQueuedMessage && (
                      <Pressable
                        onPress={() => onRemoveQueuedMessage(msg.id)}
                        className="h-6 w-6 items-center justify-center"
                      >
                        <Trash2
                          className="h-3 w-3 text-muted-foreground"
                          size={12}
                        />
                      </Pressable>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Main input container */}
      <View
        ref={dropZoneRef as any}
        className={cn(
          "relative border bg-muted/30 overflow-hidden",
          queuedMessages.length > 0 ? "rounded-b-xl" : "rounded-xl",
          isDragOver ? "border-primary border-dashed" : "border-border/60"
        )}
      >
        {/* Skill picker dropdown */}
        {showSkillPicker && filteredSkills.length > 0 && (
          <View className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] rounded-md border border-border bg-popover shadow-md z-50">
            <ScrollView>
              {filteredSkills.map((skill, index) => (
                <Pressable
                  key={skill.name}
                  onPress={() => selectSkill(skill)}
                  className={cn(
                    "w-full px-3 py-2",
                    index === selectedIndex && "bg-accent"
                  )}
                >
                  <Text className="font-medium text-sm text-foreground">
                    /{skill.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {skill.description}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

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

        {/* TextInput */}
        <TextInput
          ref={textInputRef}
          value={voiceInput.isRecording && voiceInput.liveTranscript ? voiceInput.liveTranscript : inputValue}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmit}
          onKeyPress={(e: any) => {
            if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder={placeholder}
          placeholderTextColor="#9ca3af"
          accessibilityLabel="Chat message input"
          editable={!disabled && !voiceInput.isRecording}
          multiline
          blurOnSubmit={false}
          className={cn(
            "min-h-[60px] max-h-[200px] w-full",
            "bg-transparent",
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
                  disabled={disabled || isStreaming}
                  className={cn(
                    "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
                    interactionMode === "agent" && "bg-muted/50",
                    interactionMode === "plan" &&
                      "border border-amber-500/45 bg-amber-500/12",
                    interactionMode === "ask" &&
                      "border border-emerald-500/45 bg-emerald-500/12"
                  )}
                  testID="interaction-mode-trigger"
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


            {/* Quick Actions selector */}
            {quickActions.length > 0 && (
              <Popover
                placement="top"
                size="xs"
                isOpen={quickActionsOpen}
                onOpen={() => setQuickActionsOpen(true)}
                onClose={() => setQuickActionsOpen(false)}
                trigger={(triggerProps) => (
                  <Pressable
                    {...triggerProps}
                    disabled={disabled || isStreaming}
                    className={cn(
                      "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
                      quickActionsOpen
                        ? "border border-amber-500/45 bg-amber-500/12"
                        : "bg-muted/50"
                    )}
                  >
                    <Zap
                      className={cn(
                        "h-2.5 w-2.5",
                        quickActionsOpen ? "text-amber-400" : "text-muted-foreground"
                      )}
                      size={10}
                    />
                    <Text
                      className={cn(
                        "text-xs",
                        quickActionsOpen ? "text-amber-400" : "text-muted-foreground"
                      )}
                    >
                      Actions
                    </Text>
                    <ChevronDown
                      className={cn(
                        "h-2 w-2",
                        quickActionsOpen ? "text-amber-400/80" : "text-muted-foreground/60"
                      )}
                      size={8}
                    />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[280px] p-0">
                  <View className="py-1">
                    {quickActions.map((action) => (
                      <Pressable
                        key={action.label}
                        onPress={() => {
                          onQuickActionClick?.(action.prompt)
                          setQuickActionsOpen(false)
                        }}
                        className="flex-row items-center gap-3 p-3 rounded-lg mb-1"
                      >
                        <View className="w-8 items-center">
                          <Zap className="h-3.5 w-3.5 text-amber-400" size={14} />
                        </View>
                        <View className="flex-1">
                          <Text className="font-medium text-sm text-foreground">
                            {action.label}
                          </Text>
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {action.prompt}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </PopoverContent>
              </Popover>
            )}

            {/* Model selector */}
            <Popover
              placement="top"
              size="xs"
              isOpen={modelPickerOpen}
              onOpen={() => setModelPickerOpen(true)}
              onClose={() => setModelPickerOpen(false)}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  disabled={disabled || isStreaming}
                  className="h-[22px] flex-row items-center gap-1 rounded-md px-1.5"
                >
                  <Text className="text-xs text-muted-foreground">
                    {getModelShortDisplayName(currentModelId)}
                  </Text>
                  <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
                </Pressable>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="w-[260px] p-0 max-h-[320px]">
                <ScrollView>
                  {MODEL_GROUPS.map((group) => (
                    <View key={group.label}>
                      <View className="px-3 pt-2.5 pb-1">
                        <Text className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          {group.label}
                        </Text>
                      </View>
                      {group.models.map((model) => {
                        const isSelected = currentModelId === model.id
                        const isLocked = !effectiveIsPro && model.tier !== "economy"
                        return (
                          <Pressable
                            key={model.id}
                            onPress={() => {
                              handleModelChange(model.id)
                              setModelPickerOpen(false)
                            }}
                            className={cn(
                              "flex-row items-center gap-2.5 px-3 py-2",
                              isSelected && "bg-accent",
                              isLocked && "opacity-50"
                            )}
                          >
                            <View className="flex-1">
                              <Text className={cn("text-sm", isLocked ? "text-muted-foreground" : "text-foreground")}>
                                {model.displayName}
                              </Text>
                            </View>
                            {isLocked ? (
                              <Lock className="h-3 w-3 text-muted-foreground" size={12} />
                            ) : isSelected ? (
                              <Check className="h-3.5 w-3.5 text-primary" size={14} />
                            ) : (
                              <Text
                                className={cn(
                                  "text-[10px]",
                                  model.tier === "premium" ? "text-amber-500" :
                                  model.tier === "economy" ? "text-emerald-500" :
                                  "text-muted-foreground"
                                )}
                              >
                                {TIER_LABELS[model.tier]}
                              </Text>
                            )}
                          </Pressable>
                        )
                      })}
                    </View>
                  ))}
                </ScrollView>
              </PopoverContent>
            </Popover>

          </View>

          {/* Right side buttons */}
          {voiceInput.isRecording ? (
            <View className="flex-row items-center gap-2">
              <VoiceWaveform />
              <Pressable
                onPress={() => voiceInput.toggleRecording().catch(() => {})}
                role="button"
                accessibilityLabel="Stop voice recording"
                className="h-6 w-6 rounded-full bg-foreground/90 items-center justify-center active:opacity-70"
              >
                <Square className="text-background" size={10} fill="currentColor" />
              </Pressable>
            </View>
          ) : (
          <View className="flex-row items-center gap-1">
            {contextUsage && (
              <ContextTracker
                inputTokens={contextUsage.inputTokens}
                contextWindowTokens={contextUsage.contextWindowTokens}
              />
            )}

            <Pressable
              onPress={handleAttachClick}
              disabled={disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES}
              role="button"
              accessibilityLabel="Attach file"
              className="min-h-5 min-w-5 rounded-full items-center justify-center active:opacity-70"
              android_ripple={{ color: "rgba(128,128,128,0.25)" }}
            >
              <Plus
                className={cn(
                  "h-4 w-4",
                  disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES
                    ? "text-muted-foreground/40"
                    : "text-muted-foreground"
                )}
                size={12}
              />
            </Pressable>

            {isStreaming ? (
              <>
                <Pressable
                  onPress={onStop}
                  accessibilityLabel="Stop"
                  testID="stop-streaming"
                  className="h-5 w-5 rounded-full bg-destructive items-center justify-center active:opacity-70"
                >
                  <Square
                    className="text-destructive-foreground m-auto"
                    size={10}
                  />
                </Pressable>
                {(inputValue.trim() || pendingFiles.length > 0) && (
                  <Pressable
                    onPress={handleSubmit}
                    disabled={disabled || isProcessingFiles}
                    role="button"
                    accessibilityLabel="Queue message"
                    className="h-5 w-5 rounded-full items-center justify-center bg-primary"
                  >
                    <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
                  </Pressable>
                )}
              </>
            ) : (inputValue.trim() || pendingFiles.length > 0) ? (
              <Pressable
                onPress={handleSubmit}
                disabled={disabled || isProcessingFiles}
                role="button"
                accessibilityLabel="Send message"
                className={cn(
                  "h-5 w-5 rounded-full items-center justify-center bg-primary",
                  (disabled || isProcessingFiles) && "opacity-50"
                )}
              >
                <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
              </Pressable>
            ) : voiceInput.canRecord ? (
              <Pressable
                onPress={() => {
                  voiceInput.clearError()
                  voiceInput.toggleRecording().catch(() => {})
                }}
                disabled={disabled || isProcessingFiles}
                role="button"
                accessibilityLabel="Start voice recording"
                className="h-5 w-5 rounded-full items-center justify-center active:opacity-70"
              >
                <Mic
                  className={cn(
                    "h-4 w-4",
                    disabled || isProcessingFiles
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground"
                  )}
                  size={14}
                />
              </Pressable>
            ) : null}
          </View>
          )}
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

export default ChatInput

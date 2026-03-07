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
 * Mobile uses file picker stub.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { usePlatformConfig } from "../../lib/platform-config"
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
} from "lucide-react-native"

export type AgentMode = "basic" | "advanced"

export interface AgentModeConfig {
  id: AgentMode
  label: string
  description: string
  icon: React.ReactNode
  creditHint: string
  requiresPro?: boolean
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

interface SkillOption {
  name: string
  description: string
}

const SKILLS: SkillOption[] = []

const AGENT_MODES: AgentModeConfig[] = [
  {
    id: "basic",
    label: "Basic",
    description: "Fast responses, 4x cheaper",
    icon: <Zap className="h-3.5 w-3.5 text-muted-foreground" size={14} />,
    creditHint: "~0.2 credits",
    requiresPro: false,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "More capable, better quality",
    icon: <Rocket className="h-3.5 w-3.5 text-muted-foreground" size={14} />,
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
  isStreaming?: boolean
  onStop?: () => void
  agentMode?: AgentMode
  onAgentModeChange?: (mode: AgentMode) => void
  isPro?: boolean
  onUpgradeClick?: () => void
  queuedMessages?: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
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
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
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
  const [agentModeOpen, setAgentModeOpen] = useState(false)

  const [internalAgentMode, setInternalAgentMode] = useState<AgentMode>(
    effectiveIsPro ? "advanced" : "basic"
  )
  const agentMode = controlledAgentMode ?? internalAgentMode

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

  const currentAgentConfig = useMemo(
    () => AGENT_MODES.find((m) => m.id === agentMode) || AGENT_MODES[1],
    [agentMode]
  )

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
    }
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
    if ((!trimmedContent && pendingFiles.length === 0) || disabled || isProcessingFiles) return

    const fileData =
      pendingFiles.length > 0 ? pendingFiles.map((f) => f.dataUrl) : undefined

    onSubmit(trimmedContent, fileData, agentMode)
    setInputValue("")
    setPendingFiles([])
    setFileError(null)

    textInputRef.current?.focus()
  }, [disabled, onSubmit, pendingFiles, isProcessingFiles, agentMode, inputValue])

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
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="p-3 pt-0"
    >
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

      {/* Queued messages */}
      {queuedMessages.length > 0 && (
        <View className="mb-2 rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
          <Pressable
            onPress={() => setQueueExpanded((prev) => !prev)}
            className="w-full flex-row items-center justify-between px-3 py-2"
          >
            <View className="flex-row items-center gap-2">
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground",
                  !queueExpanded && "-rotate-90"
                )}
                size={16}
              />
              <Text className="font-medium text-sm text-foreground">
                {queuedMessages.length} Queued
              </Text>
            </View>
          </Pressable>
          {queueExpanded && (
            <View className="border-t border-border/60">
              {queuedMessages.map((msg, index) => (
                <View
                  key={msg.id}
                  className="flex-row items-center gap-3 px-3 py-2.5 border-b border-border/40 last:border-b-0"
                >
                  <View className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
                  <View className="flex-1 min-w-0">
                    <Text className="text-xs text-foreground" numberOfLines={1}>
                      {msg.content ||
                        (msg.imageData && msg.imageData.length > 0
                          ? `${msg.imageData.length} image(s)`
                          : "Empty message")}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-0.5">
                    {onReorderQueuedMessage && (
                      <>
                        <Pressable
                          onPress={() => onReorderQueuedMessage(msg.id, "up")}
                          disabled={index === 0}
                          className="h-6 w-6 items-center justify-center"
                        >
                          <ChevronUp
                            className={cn(
                              "h-3 w-3",
                              index === 0
                                ? "text-muted-foreground/30"
                                : "text-muted-foreground"
                            )}
                            size={12}
                          />
                        </Pressable>
                        <Pressable
                          onPress={() => onReorderQueuedMessage(msg.id, "down")}
                          disabled={index === queuedMessages.length - 1}
                          className="h-6 w-6 items-center justify-center"
                        >
                          <ChevronDown
                            className={cn(
                              "h-3 w-3",
                              index === queuedMessages.length - 1
                                ? "text-muted-foreground/30"
                                : "text-muted-foreground"
                            )}
                            size={12}
                          />
                        </Pressable>
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
          "relative rounded-xl border bg-muted/30 overflow-hidden",
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

        {/* Hidden file input for web */}
        {Platform.OS === "web" && (
          <input
            ref={fileInputRef as any}
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.csv,.json"
            onChange={handleWebFileChange}
            style={{ display: "none" }}
          />
        )}

        {/* TextInput */}
        <TextInput
          ref={textInputRef}
          value={inputValue}
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
          editable={!disabled}
          multiline
          blurOnSubmit={false}
          className={cn(
            "min-h-[60px] max-h-[200px] w-full",
            "bg-transparent",
            "px-4 pt-4 pb-2 text-xs text-foreground",
            disabled && "opacity-50"
          )}
          textAlignVertical="top"
          style={Platform.OS === "web" ? { outlineStyle: "none" } as any : undefined}
        />

        {/* Bottom toolbar */}
        <View className="flex-row items-center justify-between px-2 pb-2">
          {/* Left side buttons */}
          <View className="flex-row items-center gap-1">
            {/* Attach button */}
            <Pressable
              onPress={handleAttachClick}
              disabled={disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES}
              className="h-8 w-8 rounded-full items-center justify-center"
            >
              <Plus
                className={cn(
                  "h-4 w-4",
                  disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES
                    ? "text-muted-foreground/40"
                    : "text-muted-foreground"
                )}
                size={16}
              />
            </Pressable>

            {/* Agent mode selector */}
            <Pressable
              onPress={() => setAgentModeOpen(true)}
              disabled={disabled || isStreaming}
              className="h-8 flex-row items-center gap-1.5 rounded-full px-3"
            >
              {currentAgentConfig.icon}
              <Text className="text-xs text-muted-foreground">
                {currentAgentConfig.label}
              </Text>
            </Pressable>

            <Modal
              visible={agentModeOpen}
              transparent
              animationType="fade"
              onRequestClose={() => setAgentModeOpen(false)}
            >
              <Pressable
                className="flex-1 bg-black/50 justify-end"
                onPress={() => setAgentModeOpen(false)}
              >
                <Pressable
                  className="bg-card rounded-t-2xl border-t border-border p-4 pb-8"
                  onPress={(e) => e.stopPropagation()}
                >
                  <View className="w-10 h-1 rounded-full bg-muted-foreground/30 self-center mb-4" />
                  <Text className="text-sm font-semibold text-foreground mb-3 px-1">
                    Agent Mode
                  </Text>
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
                            mode.icon
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
                </Pressable>
              </Pressable>
            </Modal>
          </View>

          {/* Right side buttons */}
          <View className="flex-row items-center gap-1">
            {isStreaming ? (
              <Pressable
                onPress={onStop}
                className="h-8 w-8 rounded-full bg-destructive items-center justify-center"
              >
                <Square
                  className="h-3.5 w-3.5 text-destructive-foreground"
                  size={14}
                />
              </Pressable>
            ) : (
              <Pressable
                onPress={handleSubmit}
                disabled={disabled || isProcessingFiles}
                className={cn(
                  "h-8 w-8 rounded-full items-center justify-center bg-primary",
                  (disabled || isProcessingFiles) && "opacity-50"
                )}
              >
                <ArrowUp
                  className="h-4 w-4 text-primary-foreground"
                  size={16}
                />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

export default ChatInput

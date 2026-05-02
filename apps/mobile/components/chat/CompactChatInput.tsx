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
  getModelsByProvider,
  getModelShortDisplayName,
  getModelTier,
  AUTO_MODEL_ID,
  type ModelTier,
} from "@shogo/model-catalog"
import {
  ArrowUp,
  Plus,
  Loader2,
  X,
  File,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  Lock,
  Check,
  Mic,
  Square,
} from "lucide-react-native"
import { AutoModelOption } from "./AutoModelOption"
import {
  INTERACTION_MODES,
  DEFAULT_MODEL_PRO,
  DEFAULT_MODEL_FREE,
  type FileAttachment,
  type InteractionMode,
} from "./ChatInput"
import { usePlatformConfig } from "../../lib/platform-config"
import { useVoiceInput } from "./useVoiceInput"
import { VoiceWaveform } from "./VoiceWaveform"
import {
  analyzeContent,
  extractLongPaste,
  kindLabel,
  LONG_PASTE_MIN_CHARS,
  MAX_PASTED_TEXTS,
  buildPastedAttachments,
  type PastedTextEntry,
} from "./long-text-utils"
import { FileViewerModal } from "./FileViewerModal"
import { PastedTextChip } from "./PastedTextChip"
import { EnvironmentPicker } from "./EnvironmentPicker"

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
  onSubmit: (prompt: string, files?: FileAttachment[]) => void | false
  disabled?: boolean
  isLoading?: boolean
  placeholder?: string
  className?: string
  value?: string
  onChange?: (value: string) => void
  interactionMode?: InteractionMode
  onInteractionModeChange?: (mode: InteractionMode) => void
  selectedModel?: string
  onModelChange?: (modelId: string) => void
  isPro?: boolean
  onUpgradeClick?: () => void
  /** When false, disabled state does not dim the composer (e.g. plan-mode suggestion keeps draft readable). */
  dimWhenDisabled?: boolean
  /**
   * Optional opt-in handler that replaces the default `useVoiceInput`
   * dictation behavior on the empty-composer mic button. When provided,
   * tapping the mic invokes this handler instead of starting local
   * speech-to-text — the homepage uses this to open Shogo Mode for
   * project creation while preemptively warming a runtime pod.
   */
  onStartVoiceProjectCreation?: () => void | Promise<void>
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
      selectedModel: controlledModel,
      onModelChange,
      isPro = false,
      onUpgradeClick,
      dimWhenDisabled = true,
      onStartVoiceProjectCreation,
    },
    ref
  ) {
    const { features } = usePlatformConfig()
    const effectiveIsPro = features.billing ? isPro : true

    const [internalValue, setInternalValue] = useState("")
    const textInputRef = useRef<TextInput>(null)
    const pasteHandledRef = useRef(false)

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const [attachSheetOpen, setAttachSheetOpen] = useState(false)
    const [interactionModeOpen, setInteractionModeOpen] = useState(false)
    const [modelPickerOpen, setModelPickerOpen] = useState(false)
    const [internalInteractionMode, setInternalInteractionMode] =
      useState<InteractionMode>("agent")
    const interactionMode = controlledInteractionMode ?? internalInteractionMode

    const [internalModel, setInternalModel] = useState<string>(
      effectiveIsPro ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE
    )
    const currentModelId = controlledModel ?? internalModel

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

    const currentInteractionConfig = useMemo(
      () => INTERACTION_MODES.find((m) => m.id === interactionMode) || INTERACTION_MODES[0],
      [interactionMode]
    )

    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const dropZoneRef = useRef<View>(null)

    const value = controlledValue ?? internalValue
    const setValue = controlledOnChange ?? setInternalValue
    const valueRef = useRef(value)

    useEffect(() => {
      valueRef.current = value
    }, [value])

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

    const handleAttachClick = useCallback(() => {
      if (Platform.OS === "web") {
        fileInputRef.current?.click()
        return
      }
      setAttachSheetOpen(true)
    }, [])

    const processFiles = useCallback((files: FileList | File[]) => {
      Array.from(files).forEach((file: File) => {
        const isZip =
          file.name.toLowerCase().endsWith(".zip") ||
          file.type === "application/zip" ||
          file.type === "application/x-zip-compressed"
        if (!isZip && file.size > MAX_FILE_SIZE) {
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

    // Long-text pastes get extracted out of the TextInput and rendered as
    // compact file-style chips. The input remains editable so users can
    // keep typing and paste multiple long blocks (each becomes a chip).
    const [pastedTexts, setPastedTexts] = useState<PastedTextEntry[]>([])
    const [viewingPastedId, setViewingPastedId] = useState<string | null>(null)

    const addPastedText = useCallback((content: string) => {
      const info = analyzeContent(content)
      if (!info.isLong) return false
      setPastedTexts((prev) => {
        if (prev.length >= MAX_PASTED_TEXTS) return prev
        return [
          ...prev,
          {
            id: `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            content,
            info,
          },
        ]
      })
      return true
    }, [])

    const handleRemovePastedText = useCallback((id: string) => {
      setPastedTexts((prev) => prev.filter((p) => p.id !== id))
      setViewingPastedId((curr) => (curr === id ? null : curr))
    }, [])

    const viewingPasted = useMemo(
      () => pastedTexts.find((p) => p.id === viewingPastedId) ?? null,
      [pastedTexts, viewingPastedId]
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
      const handlePaste = (e: ClipboardEvent) => {
        const cd = e.clipboardData
        if (!cd) return
        const items = cd.items
        const imageFiles: File[] = []
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith("image/")) {
              const file = items[i].getAsFile()
              if (file) imageFiles.push(file)
            }
          }
        }
        if (imageFiles.length > 0) {
          e.preventDefault()
          processFiles(imageFiles as any)
          return
        }
        const text = cd.getData("text")
        if (text && text.length >= LONG_PASTE_MIN_CHARS) {
          const info = analyzeContent(text)
          if (info.isLong) {
            e.preventDefault()
            pasteHandledRef.current = true
            addPastedText(text)
            setTimeout(() => { pasteHandledRef.current = false }, 0)
          }
        }
      }

      node.addEventListener("dragover", handleDragOver)
      node.addEventListener("drop", handleDrop)
      node.addEventListener("paste", handlePaste as EventListener)
      return () => {
        node.removeEventListener("dragover", handleDragOver)
        node.removeEventListener("drop", handleDrop)
        node.removeEventListener("paste", handlePaste as EventListener)
      }
    }, [processFiles, addPastedText])

    const appendTranscriptToInput = useCallback(
      (transcript: string) => {
        const normalized = transcript.trim()
        if (!normalized) return

        const currentValue = valueRef.current
        const nextValue =
          currentValue.length === 0 || /\s$/.test(currentValue)
            ? `${currentValue}${normalized}`
            : `${currentValue} ${normalized}`

        setValue(nextValue)
        setTimeout(() => textInputRef.current?.focus(), 0)
      },
      [setValue]
    )

    const voiceInput = useVoiceInput({
      onTranscript: appendTranscriptToInput,
    })

    const handleSubmit = useCallback(() => {
      const trimmedContent = value.trim()
      if (
        (!trimmedContent && pendingFiles.length === 0 && pastedTexts.length === 0) ||
        disabled ||
        isLoading ||
        voiceInput.isBusy
      ) {
        return
      }

      // Pasted long-text blocks are shipped as file attachments (ChatGPT-style).
      // The typed text is sent as the message body; the model receives both the
      // text part and the file parts so it sees everything.
      const pastedAttachments: FileAttachment[] = buildPastedAttachments(pastedTexts)
      const combinedFiles: FileAttachment[] = [
        ...pendingFiles.map((f) => ({ dataUrl: f.dataUrl, name: f.name, type: f.type })),
        ...pastedAttachments,
      ]
      const fileData = combinedFiles.length > 0 ? combinedFiles : undefined

      const submitResult = onSubmit(trimmedContent, fileData)
      if (submitResult === false) {
        return
      }
      setValue("")
      setPendingFiles([])
      setFileError(null)
      setPastedTexts([])
      setViewingPastedId(null)
      textInputRef.current?.focus()
    }, [value, disabled, isLoading, onSubmit, pendingFiles, pastedTexts, voiceInput.isBusy, setValue])

    // Fallback paste detection for platforms where the DOM paste listener
    // doesn't fire (native). If a large chunk was just inserted, pull it
    // out into a chip instead of keeping it in the TextInput.
    const handleChangeText = useCallback(
      (next: string) => {
        if (pasteHandledRef.current) {
          pasteHandledRef.current = false
          return
        }

        const paste = extractLongPaste(valueRef.current, next)
        if (paste) {
          addPastedText(paste.inserted)
          setValue(paste.restored)
          return
        }
        setValue(next)
      },
      [setValue, addPastedText]
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

          {voiceInput.error && (
            <Text className="text-sm text-destructive px-4 pb-2">{voiceInput.error}</Text>
          )}

          {/* Pasted long-text chips (ChatGPT-style). Multiple allowed. */}
          {pastedTexts.length > 0 && (
            <View className="flex-row flex-wrap gap-2 px-4 pt-3">
              {pastedTexts.map((entry) => (
                <PastedTextChip
                  key={entry.id}
                  entry={entry}
                  onOpen={() => setViewingPastedId(entry.id)}
                  onRemove={() => handleRemovePastedText(entry.id)}
                />
              ))}
            </View>
          )}

          <TextInput
            ref={textInputRef}
            placeholder={placeholderText}
            placeholderTextColor="#9ca3af"
            accessibilityLabel="Describe the agent you want to build"
            value={voiceInput.isRecording && voiceInput.liveTranscript ? voiceInput.liveTranscript : value}
            onChangeText={handleChangeText}
            onSubmitEditing={handleSubmit}
            onKeyPress={(e: any) => {
              if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            editable={!disabled && !isLoading && !voiceInput.isRecording}
            multiline
            blurOnSubmit={false}
            className={cn(
              "min-h-[80px] max-h-[200px] w-full",
              "px-4 pt-4 text-xs text-foreground",
              disabled && dimWhenDisabled && "opacity-50",
              Platform.OS === "web" && "outline-none no-focus-ring"
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

              {/* Environment selector — pick Cloud or a paired machine */}
              <EnvironmentPicker disabled={disabled || isLoading} />

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
                    disabled={disabled || isLoading}
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
                    <AutoModelOption
                      currentModelId={currentModelId}
                      onSelect={() => {
                        handleModelChange(AUTO_MODEL_ID)
                        setModelPickerOpen(false)
                      }}
                    />
                    <View className="h-px bg-border/50 mx-2" />
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

                {isLoading ? (
                  <View className="h-5 w-5 rounded-full items-center justify-center bg-primary opacity-50">
                    <Loader2 className="h-3 w-3 text-primary-foreground animate-spin" size={12} />
                  </View>
                ) : (value.trim() || pendingFiles.length > 0 || pastedTexts.length > 0) ? (
                  <Pressable
                    onPress={handleSubmit}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Send message"
                    className={cn(
                      "h-5 w-5 rounded-full items-center justify-center bg-primary",
                      disabled && "opacity-50"
                    )}
                  >
                    <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
                  </Pressable>
                ) : onStartVoiceProjectCreation ? (
                  <Pressable
                    onPress={() => {
                      voiceInput.clearError()
                      void Promise.resolve(onStartVoiceProjectCreation()).catch(() => {})
                    }}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Start voice project creation"
                    className="h-5 w-5 rounded-full items-center justify-center active:opacity-70"
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        disabled
                          ? "text-muted-foreground/40"
                          : "text-muted-foreground"
                      )}
                      size={14}
                    />
                  </Pressable>
                ) : voiceInput.canRecord ? (
                  <Pressable
                    onPress={() => {
                      voiceInput.clearError()
                      voiceInput.toggleRecording().catch(() => {})
                    }}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Start voice recording"
                    className="h-5 w-5 rounded-full items-center justify-center active:opacity-70"
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        disabled
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

        {viewingPasted && (
          <FileViewerModal
            visible={viewingPastedId !== null}
            onClose={() => setViewingPastedId(null)}
            content={viewingPasted.content}
            title={`${kindLabel(viewingPasted.info.kind)} content`}
            kind={viewingPasted.info.kind}
            sizeLabel={viewingPasted.info.sizeLabel}
          />
        )}

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

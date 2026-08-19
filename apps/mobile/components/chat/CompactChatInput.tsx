// SPDX-License-Identifier: MIT
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

import React, { useState, useRef, useCallback, forwardRef, useEffect, useMemo } from "react"
import { View, Text, TextInput, Pressable, Image, ScrollView, Platform, useWindowDimensions, Animated, Easing } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { resolveShortName, resolveTier } from "../../lib/visible-models"
import { ModelPickerMenu, getNativeModelMenuWidth } from "./ModelPickerMenu"
import {
  ArrowUp,
  Plus,
  Loader2,
  X,
  File,
  FileText,
  Image as ImageIcon,
  ChevronDown,
  Mic,
  Square,
  Languages,
} from "lucide-react-native"
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
import {
  useTypingPlaceholder,
  AGENT_PLACEHOLDER_PREFIX,
} from "../../hooks/useTypingPlaceholder"

import { AttachSourceSheet } from "./AttachSourceSheet"

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

// Prefixed (rather than the generic MIN/MAX_INPUT_HEIGHT names used by
// ChatInput) so the two composers' independently-tuned bounds can't be
// mistaken for a shared source of truth that has drifted.
const COMPACT_INPUT_MIN_HEIGHT = 80
const COMPACT_INPUT_MAX_HEIGHT = 200
const COMPACT_INPUT_PROMINENT_MIN_HEIGHT = 92
const COMPACT_INPUT_PROMINENT_MAX_HEIGHT = 210
const COMPACT_INPUT_NATIVE_MIN_HEIGHT = 48
const COMPACT_INPUT_NATIVE_MAX_HEIGHT = 144

function compactNativeModelLabel(modelId: string): string {
  const label = resolveShortName(modelId)
  const lower = label.toLowerCase()
  if (lower.includes("haiku")) return "Haiku"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("gemini")) return "Gemini"
  if (lower.includes("gpt")) return "GPT"
  return label.length > 12 ? `${label.slice(0, 9)}…` : label
}

/**
 * Show a native browser tooltip on hover (web only). Wraps children in a
 * `display: contents` div with the `title` attribute so layout is unaffected
 * and the trigger's own ref (e.g. for popover positioning) isn't disturbed.
 * On native this is a transparent passthrough — the icon click opens the
 * popover menu which already shows the full label.
 */
function WebTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>
  return React.createElement(
    "div",
    { title: label, style: { display: "contents" } },
    children,
  )
}

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
  dualPlan?: boolean
  onDualPlanChange?: (enabled: boolean) => void
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
   * speech-to-text — the homepage uses this to open EZ Mode for
   * project creation while preemptively warming a runtime pod.
   */
  onStartVoiceProjectCreation?: () => void | Promise<void>
  /**
   * When true, the input runs the rotating "Ask Shogo to ..." typewriter
   * effect locally as its placeholder while the input is empty. Owning the
   * timer here means the per-character placeholder updates only re-render
   * this component, instead of cascading through the parent screen on
   * every tick (~30Hz). Overrides `placeholder` while the typewriter is
   * actively rendering.
   */
  agentPlaceholderActive?: boolean
  /**
   * Optional element rendered at the very left of the bottom toolbar,
   * before the mode picker. Used by the home composer to surface the
   * project-source menu ("New project / Open folder / Import") as a
   * first-class chip alongside model + mode. Pass `null` (the default)
   * for in-project chats where source-of-project doesn't apply.
   */
  leadingControls?: React.ReactNode
  /** Native phone polish for the Home composer: larger touch targets, brighter text, and focus styling. */
  prominentMobile?: boolean
  /** Resolved native Home color scheme for the prominent composer surface. */
  prominentColorScheme?: "light" | "dark"
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
      dualPlan = false,
      onDualPlanChange,
      selectedModel: controlledModel,
      onModelChange,
      isPro = false,
      onUpgradeClick,
      dimWhenDisabled = true,
      onStartVoiceProjectCreation,
      agentPlaceholderActive = false,
      leadingControls,
      prominentMobile = false,
      prominentColorScheme = "dark",
    },
    ref
  ) {
    const { features } = usePlatformConfig()
    const { width: windowWidth } = useWindowDimensions()
    const effectiveIsPro = features.billing ? isPro : true
    const isNative = Platform.OS !== "web"
    const isNativePhone = Platform.OS !== "web" && windowWidth < 600
    const useProminentComposer = prominentMobile && isNativePhone
    const useLightProminentComposer = useProminentComposer && prominentColorScheme === "light"
    const useCurrentNativeSizing = isNative && !useProminentComposer
    const inputMinHeight = useProminentComposer
      ? COMPACT_INPUT_PROMINENT_MIN_HEIGHT
      : useCurrentNativeSizing
        ? COMPACT_INPUT_NATIVE_MIN_HEIGHT
        : COMPACT_INPUT_MIN_HEIGHT
    const inputMaxHeight = useProminentComposer
      ? COMPACT_INPUT_PROMINENT_MAX_HEIGHT
      : useCurrentNativeSizing
        ? COMPACT_INPUT_NATIVE_MAX_HEIGHT
        : COMPACT_INPUT_MAX_HEIGHT
    const modelTriggerMaxWidth = useProminentComposer
      ? Math.max(54, Math.min(80, Math.floor(windowWidth * 0.18)))
      : Math.max(50, Math.min(62, Math.floor(windowWidth * 0.16)))
    const nativeModelMenuWidth = getNativeModelMenuWidth(windowWidth)

    const [internalValue, setInternalValue] = useState("")
    const [inputHeight, setInputHeight] = useState(inputMinHeight)
    const [isFocused, setIsFocused] = useState(false)
    const focusProgress = useRef(new Animated.Value(0)).current
    const rgbBorderProgress = useRef(new Animated.Value(0)).current
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
        const tier = resolveTier(modelId)
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

    useEffect(() => {
      setInputHeight((h) => Math.min(inputMaxHeight, Math.max(inputMinHeight, h)))
    }, [inputMaxHeight, inputMinHeight])

    useEffect(() => {
      if (!useProminentComposer) {
        focusProgress.setValue(0)
        return
      }
      Animated.timing(focusProgress, {
        toValue: isFocused ? 1 : 0,
        duration: isFocused ? 170 : 140,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start()
    }, [focusProgress, isFocused, useProminentComposer])

    useEffect(() => {
      if (!useProminentComposer) {
        rgbBorderProgress.stopAnimation()
        rgbBorderProgress.setValue(0)
        return
      }

      rgbBorderProgress.setValue(0)
      const animation = Animated.loop(
        Animated.timing(rgbBorderProgress, {
          toValue: 1,
          duration: 5200,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      )
      animation.start()
      return () => animation.stop()
    }, [rgbBorderProgress, useProminentComposer])

    // Run the rotating typewriter locally so its 25–45ms ticks only
    // re-render this component, not whatever screen owns the input. The
    // hook short-circuits to an empty string when disabled, so there is no
    // ongoing timer when the user has typed something or the host hasn't
    // opted in via `agentPlaceholderActive`.
    const typingPlaceholder = useTypingPlaceholder(undefined, {
      enabled: agentPlaceholderActive && !value,
    })

    const placeholderText = agentPlaceholderActive
      ? `${AGENT_PLACEHOLDER_PREFIX}${typingPlaceholder}`
      : (placeholderProp ??
        (interactionMode === "plan"
          ? "Describe what you want to plan..."
          : interactionMode === "ask"
            ? "Ask a question..."
            : "Describe the agent you want to build..."))

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
        const lowerName = file.name.toLowerCase()
        const isExempt =
          lowerName.endsWith(".zip") ||
          lowerName.endsWith(".shogo") ||
          lowerName.endsWith(".shogo-project") ||
          file.type === "application/zip" ||
          file.type === "application/x-zip-compressed"
        if (!isExempt && file.size > MAX_FILE_SIZE) {
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

    const handleUpdatePastedText = useCallback(
      (id: string, content: string) => {
        setPastedTexts((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, content, info: analyzeContent(content) } : p
          )
        )
      },
      []
    )

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
      setInputHeight(inputMinHeight)
      setPendingFiles([])
      setFileError(null)
      setPastedTexts([])
      setViewingPastedId(null)
      textInputRef.current?.focus()
    }, [value, disabled, isLoading, onSubmit, pendingFiles, pastedTexts, voiceInput.isBusy, setValue, inputMinHeight])

    const handleSubmitEditing = useCallback(() => {
      if (Platform.OS === "web") {
        handleSubmit()
        return
      }
      textInputRef.current?.blur()
    }, [handleSubmit])

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
        if (next.length === 0) {
          setInputHeight(inputMinHeight)
        }
      },
      [setValue, addPastedText, inputMinHeight]
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
        <Animated.View
          ref={dropZoneRef as any}
          className={cn(
            "relative rounded-xl border bg-card border-border/60",
            !useProminentComposer && "overflow-hidden"
          )}
          style={
            useProminentComposer
              ? {
                  borderRadius: 22,
                  borderWidth: 1,
                  borderColor: rgbBorderProgress.interpolate({
                    inputRange: [0, 0.33, 0.66, 1],
                    outputRange: useLightProminentComposer
                      ? ["#3c4863", "#604c52", "#70475c", "#3c4863"]
                      : ["#66728f", "#80696d", "#906078", "#66728f"],
                  }),
                  backgroundColor: useLightProminentComposer
                    ? "rgba(250,251,253,0.96)"
                    : "rgba(24,25,28,0.96)",
                  transform: [
                    {
                      scale: focusProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 1.006],
                      }),
                    },
                  ],
                }
              : undefined
          }
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
            testID="home-composer-input"
            placeholder={placeholderText}
            placeholderTextColor={useProminentComposer ? (useLightProminentComposer ? "#667085" : "#c4c8d1") : "#9ca3af"}
            accessibilityLabel="Describe the agent you want to build"
            value={voiceInput.isRecording && voiceInput.liveTranscript ? voiceInput.liveTranscript : value}
            onChangeText={handleChangeText}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onSubmitEditing={handleSubmitEditing}
            onKeyPress={(e: any) => {
              if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            editable={!disabled && !isLoading && !voiceInput.isRecording}
            multiline
            blurOnSubmit={Platform.OS !== "web"}
            returnKeyType={Platform.OS === "web" ? undefined : "done"}
            onContentSizeChange={(e) => {
              const h = e.nativeEvent.contentSize.height
              const clamped = Math.min(inputMaxHeight, Math.max(inputMinHeight, h))
              if (clamped !== inputHeight) {
                setInputHeight(clamped)
              }
            }}
            style={[
              { height: inputHeight },
              useProminentComposer
                ? {
                    color: useLightProminentComposer ? "#202938" : "#f8fafc",
                    fontSize: 14,
                    lineHeight: 21,
                  }
                : useCurrentNativeSizing
                  ? { fontSize: 16, lineHeight: 22 }
                  : null,
            ]}
            className={cn(
              useProminentComposer
                ? "min-h-[92px] max-h-[210px] w-full px-4 pt-4 text-sm text-foreground"
                : useCurrentNativeSizing
                  ? "min-h-[48px] max-h-[144px] w-full px-4 pt-3 text-base text-foreground"
                  : "min-h-[80px] max-h-[200px] w-full px-4 pt-4 text-xs text-foreground",
              disabled && dimWhenDisabled && "opacity-50",
              Platform.OS === "web" && "outline-none no-focus-ring"
            )}
            textAlignVertical="top"
          />

          {/* Bottom toolbar */}
          <View
            className={cn(
              "flex-row items-center justify-between",
              useProminentComposer
                ? "px-2 pb-2.5 pt-1.5"
                : useCurrentNativeSizing
                  ? "min-h-12 px-2 py-1"
                  : "p-1.5",
              isNativePhone && "items-end gap-y-1"
            )}
          >
            {/* Left side buttons */}
            <View
              className={cn(
                "flex-row items-center",
                useProminentComposer
                  ? "min-w-0 flex-1 gap-1.5"
                  : useCurrentNativeSizing
                    ? "min-w-0 flex-1 gap-1"
                    : "gap-1",
                isNativePhone && !useProminentComposer && "min-w-0 flex-1 flex-wrap"
              )}
            >
              {/* Caller-supplied leading slot (e.g. project-source menu
                  on the home composer). Rendered before built-in
                  controls so it reads as "what am I creating?" prior to
                  "what mode / what model". */}
              {leadingControls}
              {/* Interaction mode selector (Agent / Plan / Ask) */}
              <Popover
                placement="top"
                size="xs"
                isOpen={interactionModeOpen}
                onOpen={() => setInteractionModeOpen(true)}
                onClose={() => setInteractionModeOpen(false)}
                trigger={(triggerProps) => (
                  <WebTooltip label={`Mode: ${currentInteractionConfig.label}`}>
                    <Pressable
                      {...triggerProps}
                      hitSlop={useCurrentNativeSizing ? 6 : undefined}
                      disabled={disabled}
                      accessibilityLabel={`Mode: ${currentInteractionConfig.label}`}
                      className={cn(
                        useProminentComposer
                          ? "h-7 w-7 items-center justify-center rounded-lg border border-border/45 bg-muted/30"
                          : useCurrentNativeSizing
                            ? "h-8 w-8 items-center justify-center rounded-lg border border-border/45 bg-muted/30"
                          : "h-[22px] w-[22px] items-center justify-center rounded-md",
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
                          useProminentComposer ? "h-3.5 w-3.5" : "h-3.5 w-3.5",
                          interactionMode === "agent" && "text-muted-foreground",
                          interactionMode === "plan" && "text-amber-400",
                          interactionMode === "ask" && "text-emerald-400"
                        )}
                        size={useProminentComposer ? 13 : useCurrentNativeSizing ? 16 : 14}
                      />
                    </Pressable>
                  </WebTooltip>
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

              {/* Dual Plan toggle — only visible in Plan mode. Persistent
                  per-device preference; every subsequent plan auto-generates
                  a stakeholder summary until disabled. */}
              {interactionMode === "plan" && (
                <WebTooltip label="Also generate a stakeholder summary">
                  <Pressable
                    testID="home-dual-plan-toggle"
                    hitSlop={useCurrentNativeSizing ? 6 : undefined}
                    disabled={disabled}
                    onPress={() => onDualPlanChange?.(!dualPlan)}
                    accessibilityLabel="Also generate a stakeholder summary"
                    className={cn(
                      useProminentComposer
                        ? "h-7 w-7 items-center justify-center rounded-lg border border-border/45 bg-muted/30"
                        : useCurrentNativeSizing
                          ? "h-8 w-8 items-center justify-center rounded-lg border border-border/45 bg-muted/30"
                        : "h-[22px] w-[22px] items-center justify-center rounded-md",
                      dualPlan
                        ? "border border-sky-500/45 bg-sky-500/12"
                        : "bg-muted/50"
                    )}
                  >
                    <Languages
                      className={cn(
                        useProminentComposer ? "h-3.5 w-3.5" : "h-3.5 w-3.5",
                        dualPlan ? "text-sky-400" : "text-muted-foreground"
                      )}
                      size={useProminentComposer ? 13 : useCurrentNativeSizing ? 16 : 14}
                    />
                  </Pressable>
                </WebTooltip>
              )}

              {/* Environment selector — pick Cloud or a paired machine */}
              <EnvironmentPicker
                disabled={disabled || isLoading}
                prominentMobile={isNative}
                compactMobile={useProminentComposer}
              />

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
                    hitSlop={useCurrentNativeSizing ? 6 : undefined}
                    disabled={disabled}
                    className={cn(
                      useProminentComposer
                        ? "h-7 flex-row items-center gap-1 rounded-lg border border-border/45 bg-muted/30 px-1.5"
                        : useCurrentNativeSizing
                          ? "h-8 flex-row items-center gap-1 rounded-lg border border-border/45 bg-muted/30 px-2"
                        : "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
                      isNativePhone && "min-w-0"
                    )}
                    style={isNativePhone ? { maxWidth: modelTriggerMaxWidth } : undefined}
                  >
                    <Text
                      className={useProminentComposer
                        ? "text-[11px] text-foreground/85"
                        : useCurrentNativeSizing
                          ? "text-[13px] text-foreground/85"
                          : "text-xs text-muted-foreground"}
                      numberOfLines={1}
                    >
                      {isNativePhone ? compactNativeModelLabel(currentModelId) : resolveShortName(currentModelId)}
                    </Text>
                    <ChevronDown className="flex-shrink-0 text-muted-foreground/70" size={useCurrentNativeSizing ? 10 : 8} />
                  </Pressable>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent
                  className="p-0 max-h-[360px] web:outline-none web:overflow-visible web:max-w-none"
                  style={isNativePhone ? { width: nativeModelMenuWidth } : undefined}
                >
                  <ModelPickerMenu
                    currentModelId={currentModelId}
                    effectiveIsPro={effectiveIsPro}
                    onSelect={(modelId) => {
                      handleModelChange(modelId)
                      setModelPickerOpen(false)
                    }}
                  />
                </PopoverContent>
              </Popover>
            </View>

            {/* Right side buttons */}
            {voiceInput.isRecording ? (
              <View className={cn("flex-row flex-shrink-0 items-center", useProminentComposer ? "gap-1.5" : useCurrentNativeSizing ? "gap-1.5" : "gap-2")}>
                <VoiceWaveform />
                <Pressable
                  onPress={() => voiceInput.toggleRecording().catch(() => {})}
                  hitSlop={useCurrentNativeSizing ? 4 : undefined}
                  role="button"
                  accessibilityLabel="Stop voice recording"
                  className={cn(
                    "rounded-full bg-foreground/90 items-center justify-center active:opacity-70",
                    useProminentComposer ? "h-7 w-7" : useCurrentNativeSizing ? "h-9 w-9" : "h-6 w-6",
                  )}
                >
                  <Square className="text-background" size={useProminentComposer ? 11 : useCurrentNativeSizing ? 14 : 10} fill="currentColor" />
                </Pressable>
              </View>
            ) : (
              <View className={cn("flex-row flex-shrink-0 items-center", useProminentComposer ? "ml-2 gap-1.5" : useCurrentNativeSizing ? "ml-1 gap-1" : "gap-1")}>
                <Pressable
                  onPress={handleAttachClick}
                  hitSlop={useCurrentNativeSizing ? 4 : undefined}
                  disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
                  role="button"
                  accessibilityLabel="Attach file"
                  className={cn(
                    "rounded-full items-center justify-center active:opacity-70",
                    useProminentComposer
                      ? "h-7 w-7 border border-border/45 bg-muted/30"
                      : useCurrentNativeSizing
                        ? "h-9 w-9 border border-border/45 bg-muted/30"
                        : "min-h-5 min-w-5",
                  )}
                  android_ripple={{ color: "rgba(128,128,128,0.25)" }}
                >
                  <Plus
                    className={cn(
                      "h-4 w-4",
                      disabled || isLoading || pendingFiles.length >= MAX_FILES
                        ? "text-muted-foreground/40"
                        : "text-muted-foreground"
                    )}
                    size={useProminentComposer ? 13 : useCurrentNativeSizing ? 18 : 12}
                  />
                </Pressable>

                {isLoading ? (
                  <View className={cn("rounded-full items-center justify-center bg-primary opacity-50", useProminentComposer ? "h-7 w-7" : useCurrentNativeSizing ? "h-9 w-9" : "h-5 w-5")}>
                    <Loader2 className="h-3.5 w-3.5 text-primary-foreground animate-spin" size={useProminentComposer ? 14 : useCurrentNativeSizing ? 18 : 12} />
                  </View>
                ) : (value.trim() || pendingFiles.length > 0 || pastedTexts.length > 0) ? (
                  <Pressable
                    onPress={handleSubmit}
                    hitSlop={useCurrentNativeSizing ? 4 : undefined}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Send message"
                    className={cn(
                      "rounded-full items-center justify-center bg-primary",
                      useProminentComposer ? "h-7 w-7" : useCurrentNativeSizing ? "h-9 w-9" : "h-5 w-5",
                      disabled && "opacity-50"
                    )}
                  >
                    <ArrowUp className="h-3.5 w-3.5 text-primary-foreground" size={useProminentComposer ? 14 : useCurrentNativeSizing ? 18 : 12} />
                  </Pressable>
                ) : onStartVoiceProjectCreation ? (
                  <Pressable
                    onPress={() => {
                      voiceInput.clearError()
                      void Promise.resolve(onStartVoiceProjectCreation()).catch(() => {})
                    }}
                    hitSlop={useCurrentNativeSizing ? 4 : undefined}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Start voice project creation"
                    className={cn(
                      "rounded-full items-center justify-center active:opacity-70",
                      useProminentComposer
                        ? "h-7 w-7 border border-border/45 bg-muted/30"
                        : useCurrentNativeSizing
                          ? "h-9 w-9 border border-border/45 bg-muted/30"
                          : "h-5 w-5",
                    )}
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        disabled
                          ? "text-muted-foreground/40"
                          : "text-muted-foreground"
                      )}
                      size={useProminentComposer ? 13 : useCurrentNativeSizing ? 18 : 14}
                    />
                  </Pressable>
                ) : voiceInput.canRecord ? (
                  <Pressable
                    onPress={() => {
                      voiceInput.clearError()
                      voiceInput.toggleRecording().catch(() => {})
                    }}
                    hitSlop={useCurrentNativeSizing ? 4 : undefined}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Start voice recording"
                    className={cn(
                      "rounded-full items-center justify-center active:opacity-70",
                      useProminentComposer
                        ? "h-7 w-7 border border-border/45 bg-muted/30"
                        : useCurrentNativeSizing
                          ? "h-9 w-9 border border-border/45 bg-muted/30"
                          : "h-5 w-5",
                    )}
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        disabled
                          ? "text-muted-foreground/40"
                          : "text-muted-foreground"
                      )}
                      size={useProminentComposer ? 13 : useCurrentNativeSizing ? 18 : 14}
                    />
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        </Animated.View>

        {viewingPasted && (
          <FileViewerModal
            visible={viewingPastedId !== null}
            onClose={() => setViewingPastedId(null)}
            content={viewingPasted.content}
            title={`${kindLabel(viewingPasted.info.kind)} content`}
            kind={viewingPasted.info.kind}
            sizeLabel={viewingPasted.info.sizeLabel}
            editable
            onSave={(next) => handleUpdatePastedText(viewingPasted.id, next)}
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

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
import { ComposerModelPicker, getNativeModelMenuWidth } from "./ModelPickerMenu"
import {
  ArrowUp,
  Plus,
  Loader2,
  X,
  File,
  FileText,
  Image as ImageIcon,
  Mic,
  Square,
  Languages,
  Cloud,
} from "lucide-react-native"
import {
  executeNativeAttachAction,
  type NativeAttachAction,
  type NativePickedAttachment,
} from "../../lib/native-attachment-picker"
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
import {
  CHATGPT_COMPOSER,
  ComposerPlusModeList,
  ComposerPlusSection,
  ComposerPlusSheet,
  compactNativeModelLabel,
} from "./ComposerPlusMenu"

export { ComposerPlusSection } from "./ComposerPlusMenu"

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10

// Prefixed (rather than the generic MIN/MAX_INPUT_HEIGHT names used by
// ChatInput) so the two composers' independently-tuned bounds can't be
// mistaken for a shared source of truth that has drifted.
const COMPACT_INPUT_MIN_HEIGHT = 80
const COMPACT_INPUT_MAX_HEIGHT = 200
const COMPACT_INPUT_PROMINENT_MIN_HEIGHT = 24
const COMPACT_INPUT_PROMINENT_MAX_HEIGHT = 100
const COMPACT_INPUT_PROMINENT_LINE_HEIGHT = 22
const COMPACT_INPUT_PROMINENT_RADIUS = 28
const COMPACT_INPUT_NATIVE_MIN_HEIGHT = 48
const COMPACT_INPUT_NATIVE_MAX_HEIGHT = 144

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
  /**
   * Native home plus-menu rows (project source, tech stack). Rendered as
   * accordion sections inside the left-side + button. Ignored on web.
   */
  plusMenuExtras?: React.ReactNode
  /** 0–1: home composer expands to keyboard width and squares its bottom corners. */
  keyboardExpand?: Animated.Value
  /** Native home: start the keyboard-dock morph as soon as the field is focused. */
  onFocusChange?: (focused: boolean) => void
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
      plusMenuExtras,
      keyboardExpand,
      onFocusChange,
      prominentMobile = false,
      prominentColorScheme = "dark",
    },
    ref
  ) {
    const { features } = usePlatformConfig()
    const { width: windowWidth, height: windowHeight } = useWindowDimensions()
    const effectiveIsPro = features.billing ? isPro : true
    const isNative = Platform.OS !== "web"
    const isNativePhone = Platform.OS !== "web" && windowWidth < 600
    const useProminentComposer = prominentMobile && isNativePhone
    const useLightProminentComposer = useProminentComposer && prominentColorScheme === "light"
    const chatgptComposer = useLightProminentComposer ? CHATGPT_COMPOSER.light : CHATGPT_COMPOSER.dark
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
    const handleComposerFocus = useCallback(() => {
      setIsFocused(true)
      onFocusChange?.(true)
    }, [onFocusChange])
    const handleComposerBlur = useCallback(() => {
      setIsFocused(false)
      onFocusChange?.(false)
    }, [onFocusChange])
    const focusProgress = useRef(new Animated.Value(0)).current
    const textInputRef = useRef<TextInput>(null)
    const pasteHandledRef = useRef(false)

    const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
    const [fileError, setFileError] = useState<string | null>(null)
    const [attachSheetOpen, setAttachSheetOpen] = useState(false)
    const [plusMenuOpen, setPlusMenuOpen] = useState(false)
    const [plusExpandedId, setPlusExpandedId] = useState<string | null>(null)
    const [interactionModeOpen, setInteractionModeOpen] = useState(false)
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

    const applyPickedFiles = useCallback((picked: NativePickedAttachment[]) => {
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
    }, [])

    const closePlusMenu = useCallback(() => {
      setPlusMenuOpen(false)
      setPlusExpandedId(null)
    }, [])

    const togglePlusSection = useCallback((id: string) => {
      setPlusExpandedId((current) => (current === id ? null : id))
    }, [])

    const handlePlusAttach = useCallback((action: NativeAttachAction) => {
      closePlusMenu()
      executeNativeAttachAction(action, {
        currentCount: pendingFiles.length,
        maxFiles: MAX_FILES,
        maxFileSizeBytes: MAX_FILE_SIZE,
        onFiles: applyPickedFiles,
        onError: (message) => setFileError(message),
      })
    }, [applyPickedFiles, closePlusMenu, pendingFiles.length])

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
    const composerDisplayValue = voiceInput.isRecording && voiceInput.liveTranscript
      ? voiceInput.liveTranscript
      : value
    const composerEmpty = composerDisplayValue.length === 0

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

    const keyboardBottomRadius = useMemo(
      () =>
        keyboardExpand
          ? keyboardExpand.interpolate({
              inputRange: [0, 1],
              outputRange: [COMPACT_INPUT_PROMINENT_RADIUS, 0],
              extrapolate: "clamp",
            })
          : COMPACT_INPUT_PROMINENT_RADIUS,
      [keyboardExpand],
    )
    const keyboardBorderWidth = useMemo(
      () =>
        keyboardExpand
          ? keyboardExpand.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0],
              extrapolate: "clamp",
            })
          : 1,
      [keyboardExpand],
    )
    const keyboardBorderColor = useMemo(
      () =>
        keyboardExpand
          ? keyboardExpand.interpolate({
              inputRange: [0, 1],
              outputRange: [chatgptComposer.border, "transparent"],
              extrapolate: "clamp",
            })
          : focusProgress.interpolate({
              inputRange: [0, 1],
              outputRange: [chatgptComposer.border, chatgptComposer.borderFocus],
            }),
      [chatgptComposer.border, chatgptComposer.borderFocus, focusProgress, keyboardExpand],
    )

    return (
      <View ref={ref} className={cn("w-full", className)}>
        <Animated.View
          ref={dropZoneRef as any}
          className={cn(
            "relative",
            !useProminentComposer && "overflow-hidden rounded-xl border bg-card border-border/60",
          )}
          style={
            useProminentComposer
              ? {
                  overflow: "hidden" as const,
                  borderTopLeftRadius: COMPACT_INPUT_PROMINENT_RADIUS,
                  borderTopRightRadius: COMPACT_INPUT_PROMINENT_RADIUS,
                  borderBottomLeftRadius: keyboardBottomRadius,
                  borderBottomRightRadius: keyboardBottomRadius,
                  borderWidth: keyboardBorderWidth,
                  borderColor: keyboardBorderColor,
                  backgroundColor: chatgptComposer.fill,
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

          {useProminentComposer ? null : (
          <TextInput
            ref={textInputRef}
            testID="home-composer-input"
            placeholder={placeholderText}
            placeholderTextColor="#9ca3af"
            accessibilityLabel="Describe the agent you want to build"
            value={voiceInput.isRecording && voiceInput.liveTranscript ? voiceInput.liveTranscript : value}
            onChangeText={handleChangeText}
            onFocus={handleComposerFocus}
            onBlur={handleComposerBlur}
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
              useCurrentNativeSizing
                ? { fontSize: 16, lineHeight: 22 }
                : null,
            ]}
            className={cn(
              useCurrentNativeSizing
                ? "min-h-[48px] max-h-[144px] w-full px-4 pt-3 text-base text-foreground"
                : "min-h-[80px] max-h-[200px] w-full px-4 pt-4 text-xs text-foreground",
              disabled && dimWhenDisabled && "opacity-50",
              Platform.OS === "web" && "outline-none no-focus-ring"
            )}
            textAlignVertical="top"
          />
          )}

          {/* Bottom toolbar — on native Home this is the ChatGPT-style pill row. */}
          <View
            className={cn(
              "flex-row items-center justify-between",
              useProminentComposer
                ? "min-h-[48px] py-1 pl-2.5 pr-1.5 overflow-hidden"
                : useCurrentNativeSizing
                  ? "min-h-12 px-2 py-1"
                  : "p-1.5",
              !useProminentComposer && isNativePhone && "items-end gap-y-1"
            )}
          >
            {/* Left side buttons */}
            <View
              className={cn(
                "flex-row items-center",
                useProminentComposer
                  ? "flex-shrink-0 gap-1"
                  : useCurrentNativeSizing
                    ? "min-w-0 flex-1 gap-1"
                    : "gap-1",
                !useProminentComposer && isNativePhone && "min-w-0 flex-1 flex-wrap"
              )}
            >
              {useProminentComposer ? (
                <>
                <Pressable
                  onPress={() => setPlusMenuOpen(true)}
                  hitSlop={6}
                  disabled={disabled || isLoading}
                  role="button"
                  accessibilityLabel="Add"
                  className={cn(
                    "h-8 w-8 items-center justify-center active:opacity-70",
                    (disabled || isLoading) && "opacity-40",
                  )}
                  testID="home-composer-plus"
                >
                  <Plus
                    color={chatgptComposer.icon}
                    size={22}
                    strokeWidth={2}
                  />
                </Pressable>
                <ComposerPlusSheet
                  visible={plusMenuOpen}
                  onClose={closePlusMenu}
                  expandedId={plusExpandedId}
                  onToggleSection={togglePlusSection}
                  maxHeight={Math.round(windowHeight * 0.72)}
                  onAttach={handlePlusAttach}
                  attachDisabled={pendingFiles.length >= MAX_FILES}
                >
                  {plusMenuExtras}
                  <ComposerPlusSection
                    id="mode"
                    label="Mode"
                    value={currentInteractionConfig.label}
                    Icon={currentInteractionConfig.Icon}
                  >
                    <ComposerPlusModeList
                      modes={INTERACTION_MODES}
                      selectedId={interactionMode}
                      onSelect={handleInteractionModeChange}
                      dualPlan={dualPlan}
                      onDualPlanChange={onDualPlanChange}
                      dualPlanDisabled={disabled}
                      dualPlanTestId="home-dual-plan-toggle"
                    />
                  </ComposerPlusSection>
                  <ComposerPlusSection
                    id="environment"
                    label="Environment"
                    Icon={Cloud}
                  >
                    <EnvironmentPicker
                      disabled={disabled || isLoading}
                      presentation="list"
                      listActive={plusExpandedId === "environment"}
                    />
                  </ComposerPlusSection>
                </ComposerPlusSheet>
                </>
              ) : (
                <>
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
                            useCurrentNativeSizing
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
                              "h-3.5 w-3.5",
                              interactionMode === "agent" && "text-muted-foreground",
                              interactionMode === "plan" && "text-amber-400",
                              interactionMode === "ask" && "text-emerald-400"
                            )}
                            size={useCurrentNativeSizing ? 16 : 14}
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

                  {interactionMode === "plan" && (
                    <WebTooltip label="Also generate a stakeholder summary">
                      <Pressable
                        testID="home-dual-plan-toggle"
                        hitSlop={useCurrentNativeSizing ? 6 : undefined}
                        disabled={disabled}
                        onPress={() => onDualPlanChange?.(!dualPlan)}
                        accessibilityLabel="Also generate a stakeholder summary"
                        className={cn(
                          useCurrentNativeSizing
                            ? "h-8 w-8 items-center justify-center rounded-lg border border-border/45 bg-muted/30"
                            : "h-[22px] w-[22px] items-center justify-center rounded-md",
                          dualPlan
                            ? "border border-sky-500/45 bg-sky-500/12"
                            : "bg-muted/50"
                        )}
                      >
                        <Languages
                          className={cn(
                            "h-3.5 w-3.5",
                            dualPlan ? "text-sky-400" : "text-muted-foreground"
                          )}
                          size={useCurrentNativeSizing ? 16 : 14}
                        />
                      </Pressable>
                    </WebTooltip>
                  )}

                  <EnvironmentPicker
                    disabled={disabled || isLoading}
                    prominentMobile={isNative}
                  />
                </>
              )}

              {/* Model selector — native phone uses a bottom sheet like the plus menu. */}
              <ComposerModelPicker
                currentModelId={currentModelId}
                effectiveIsPro={effectiveIsPro}
                disabled={disabled}
                nativeSheet={isNativePhone}
                triggerClassName={cn(
                  useProminentComposer
                    ? "h-7 shrink-0 flex-row items-center gap-0.5 rounded-full bg-muted px-2.5"
                    : useCurrentNativeSizing
                      ? "h-8 flex-row items-center gap-1 rounded-lg border border-border/45 bg-muted/30 px-2"
                    : "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
                  isNativePhone && !useProminentComposer && "min-w-0"
                )}
                triggerStyle={isNativePhone ? { maxWidth: modelTriggerMaxWidth } : undefined}
                labelClassName={useProminentComposer
                  ? "text-[12px] text-foreground/90"
                  : useCurrentNativeSizing
                    ? "text-[13px] text-foreground/85"
                    : "text-xs text-muted-foreground"}
                chevronSize={useCurrentNativeSizing ? 10 : 8}
                hitSlop={useCurrentNativeSizing ? 6 : undefined}
                label={isNativePhone ? compactNativeModelLabel(currentModelId) : resolveShortName(currentModelId)}
                menuWidth={nativeModelMenuWidth}
                onSelect={handleModelChange}
              />
            </View>

            {useProminentComposer ? (
              <View
                className="min-w-0 flex-1 justify-center"
                style={{
                  minHeight: COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                  overflow: "hidden",
                  marginLeft: 4,
                  marginRight: 4,
                }}
              >
                {composerEmpty ? (
                  <Text
                    pointerEvents="none"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                      position: "absolute",
                      left: 4,
                      right: 4,
                      top: 0,
                      height: COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                      fontSize: 16,
                      lineHeight: COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                      color: chatgptComposer.placeholder,
                    }}
                  >
                    {placeholderText}
                  </Text>
                ) : null}
                <TextInput
                  ref={textInputRef}
                  testID="home-composer-input"
                  placeholder=""
                  accessibilityLabel="Describe the agent you want to build"
                  value={composerDisplayValue}
                  onChangeText={handleChangeText}
                  onFocus={handleComposerFocus}
                  onBlur={handleComposerBlur}
                  onSubmitEditing={handleSubmitEditing}
                  editable={!disabled && !isLoading && !voiceInput.isRecording}
                  multiline
                  scrollEnabled={inputHeight > COMPACT_INPUT_PROMINENT_MIN_HEIGHT}
                  blurOnSubmit
                  returnKeyType="done"
                  automaticallyAdjustKeyboardInsets={false}
                  onContentSizeChange={(e) => {
                    if (composerEmpty) {
                      if (inputHeight !== COMPACT_INPUT_PROMINENT_MIN_HEIGHT) {
                        setInputHeight(COMPACT_INPUT_PROMINENT_MIN_HEIGHT)
                      }
                      return
                    }
                    const h = e.nativeEvent.contentSize.height
                    const next = h <= COMPACT_INPUT_PROMINENT_LINE_HEIGHT + 8
                      ? COMPACT_INPUT_PROMINENT_MIN_HEIGHT
                      : Math.min(inputMaxHeight, Math.max(inputMinHeight, h))
                    if (next !== inputHeight) {
                      setInputHeight(next)
                    }
                  }}
                  style={{
                    width: "100%",
                    minHeight: COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                    height: Math.max(
                      composerEmpty ? COMPACT_INPUT_PROMINENT_MIN_HEIGHT : inputHeight,
                      COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                    ),
                    color: chatgptComposer.text,
                    fontSize: 16,
                    lineHeight: COMPACT_INPUT_PROMINENT_MIN_HEIGHT,
                    paddingHorizontal: 4,
                    paddingTop: 0,
                    paddingBottom: 0,
                    margin: 0,
                    backgroundColor: "transparent",
                    ...(Platform.OS === "android" ? { includeFontPadding: false, textAlignVertical: "center" } : null),
                  }}
                  className={cn(
                    disabled && dimWhenDisabled && "opacity-50",
                  )}
                />
              </View>
            ) : null}

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
                    useProminentComposer ? "h-8 w-8" : useCurrentNativeSizing ? "h-9 w-9" : "h-6 w-6",
                  )}
                >
                  <Square className="text-background" size={useProminentComposer ? 10 : useCurrentNativeSizing ? 14 : 10} fill="currentColor" />
                </Pressable>
              </View>
            ) : (
              <View className={cn("flex-row flex-shrink-0 items-center", useProminentComposer ? "ml-1 gap-1" : useCurrentNativeSizing ? "ml-1 gap-1" : "gap-1")}>
                {useProminentComposer ? null : (
                <Pressable
                  onPress={handleAttachClick}
                  hitSlop={useCurrentNativeSizing ? 4 : undefined}
                  disabled={disabled || isLoading || pendingFiles.length >= MAX_FILES}
                  role="button"
                  accessibilityLabel="Attach file"
                  className={cn(
                    "rounded-full items-center justify-center active:opacity-70",
                    useCurrentNativeSizing
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
                    size={useCurrentNativeSizing ? 18 : 12}
                  />
                </Pressable>
                )}

                {isLoading ? (
                  <View
                    className={cn(
                      "rounded-full items-center justify-center",
                      !useProminentComposer && "bg-primary opacity-50",
                      useProminentComposer ? "h-8 w-8" : useCurrentNativeSizing ? "h-9 w-9" : "h-5 w-5",
                    )}
                    style={useProminentComposer ? { backgroundColor: chatgptComposer.sendFill, opacity: 0.5 } : undefined}
                  >
                    <Loader2
                      className={cn("h-3.5 w-3.5 animate-spin", !useProminentComposer && "text-primary-foreground")}
                      color={useProminentComposer ? chatgptComposer.sendIcon : undefined}
                      size={useProminentComposer ? 14 : useCurrentNativeSizing ? 18 : 12}
                    />
                  </View>
                ) : (value.trim() || pendingFiles.length > 0 || pastedTexts.length > 0) ? (
                  <Pressable
                    onPress={handleSubmit}
                    hitSlop={useCurrentNativeSizing ? 4 : undefined}
                    disabled={disabled}
                    role="button"
                    accessibilityLabel="Send message"
                    className={cn(
                      "rounded-full items-center justify-center",
                      !useProminentComposer && "bg-primary",
                      useProminentComposer ? "h-8 w-8" : useCurrentNativeSizing ? "h-9 w-9" : "h-5 w-5",
                      disabled && "opacity-50"
                    )}
                    style={useProminentComposer ? { backgroundColor: chatgptComposer.sendFill } : undefined}
                  >
                    <ArrowUp
                      className={cn("h-3.5 w-3.5", !useProminentComposer && "text-primary-foreground")}
                      color={useProminentComposer ? chatgptComposer.sendIcon : undefined}
                      size={useProminentComposer ? 14 : useCurrentNativeSizing ? 18 : 12}
                    />
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
                        ? "h-8 w-8"
                        : useCurrentNativeSizing
                          ? "h-9 w-9 border border-border/45 bg-muted/30"
                          : "h-5 w-5",
                    )}
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        !useProminentComposer && (disabled ? "text-muted-foreground/40" : "text-foreground")
                      )}
                      color={useProminentComposer ? (disabled ? chatgptComposer.placeholder : chatgptComposer.icon) : undefined}
                      size={useProminentComposer ? 20 : useCurrentNativeSizing ? 18 : 14}
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
                        ? "h-8 w-8"
                        : useCurrentNativeSizing
                          ? "h-9 w-9 border border-border/45 bg-muted/30"
                          : "h-5 w-5",
                    )}
                  >
                    <Mic
                      className={cn(
                        "h-4 w-4",
                        !useProminentComposer && (disabled ? "text-muted-foreground/40" : "text-muted-foreground")
                      )}
                      color={useProminentComposer ? (disabled ? chatgptComposer.placeholder : chatgptComposer.icon) : undefined}
                      size={useProminentComposer ? 20 : useCurrentNativeSizing ? 18 : 14}
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

        {Platform.OS !== "web" && !useProminentComposer && (
          <AttachSourceSheet
            open={attachSheetOpen}
            onOpenChange={setAttachSheetOpen}
            currentCount={pendingFiles.length}
            maxFiles={MAX_FILES}
            maxFileSizeBytes={MAX_FILE_SIZE}
            onFiles={applyPickedFiles}
            onError={(message) => setFileError(message)}
          />
        )}
      </View>
    )
  }
)

export default CompactChatInput

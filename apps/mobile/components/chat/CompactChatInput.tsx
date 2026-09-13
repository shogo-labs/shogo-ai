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
import { View, Text, TextInput, Pressable, Image, ScrollView, Platform, Animated } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { NATIVE_PHONE_ICON_STROKE,
  NATIVE_PHONE_SHEET_COMPACT_RATIO } from "../../lib/native-phone-layout"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { resolveShortName, resolveTier } from "../../lib/visible-models"
import { ComposerModelPicker } from "./ModelPickerMenu"
import { WebTooltip } from "./WebTooltip"
import {
  Plus,
  X,
  Mic,
  Square,
  Languages,
  Cloud,
} from "lucide-react-native"
import {
  executeNativeAttachAction,
  type NativeAttachAction,
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
  kindLabel,
  buildPastedAttachments,
} from "./long-text-utils"
import { FileViewerModal } from "./FileViewerModal"
import { PastedTextChip } from "./PastedTextChip"
import {
  PROMINENT_COMPOSER_CHROME_Z_INDEX,
  PROMINENT_COMPOSER_HEIGHT_EASING,
  PROMINENT_COMPOSER_LINE_HEIGHT,
  PROMINENT_COMPOSER_MIN_HEIGHT,
  PROMINENT_COMPOSER_PADDING_BOTTOM,
  PROMINENT_COMPOSER_PADDING_HORIZONTAL,
  PROMINENT_COMPOSER_PADDING_TOP,
  PROMINENT_COMPOSER_RADIUS,
  PROMINENT_COMPOSER_TOOLBAR_Z_INDEX,
  nextProminentComposerHeight,
} from "./useProminentComposerExpansion"
import { EnvironmentPicker } from "./EnvironmentPicker"
import { COMPOSER_KEYBOARD_PROPS, composerSendChrome } from "../../lib/composer-phone"
import {
  useTypingPlaceholder,
  AGENT_PLACEHOLDER_PREFIX,
} from "../../hooks/useTypingPlaceholder"

import { AttachSourceSheet } from "./AttachSourceSheet"
import {
  ComposerPlusModeList,
  ComposerPlusSection,
  ComposerPlusSheet,
  compactNativeModelLabel,
} from "./ComposerPlusMenu";
import {
  formatFileSize,
  getFileIcon,
  MAX_FILE_SIZE,
  MAX_FILES,
  useComposerAttachments,
} from "../../lib/composer-attachments";
import {
  ComposerPlusTrigger,
  ComposerSendButton,
  ProminentComposerField,
  composerModelPickerProps,
  useComposerLayoutMode,
  useProminentComposerHeight,
} from "./composer"

export { ComposerPlusSection } from "./ComposerPlusMenu"

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
      prominentMobile = false,
      prominentColorScheme = "dark",
    },
    ref
  ) {
    const { features } = usePlatformConfig()
    const effectiveIsPro = features.billing ? isPro : true
    const { isNative,
      isPhoneChrome, useProminentComposer,
      chatgptComposer,
      sizes,
      modelTriggerMaxWidth,
      nativeModelMenuWidth,
      windowHeight,
    } = useComposerLayoutMode({
      prominent: prominentMobile,
      compact: true,
      colorScheme: prominentColorScheme,
    })
    const useCurrentNativeSizing = isNative && !useProminentComposer
    const sendChrome = composerSendChrome(isNative || useProminentComposer)
    const inputMinHeight = sizes.inputMinHeight
    const inputMaxHeight = sizes.inputMaxHeight
    const [internalValue, setInternalValue] = useState("")
    const [inputHeight, setInputHeight] = useState(inputMinHeight)
    const inputHeightAnimation = useRef(new Animated.Value(inputMinHeight)).current
    const [isFocused, setIsFocused] = useState(false)
    const handleComposerFocus = useCallback(() => {
      setIsFocused(true)
    }, [])
    const handleComposerBlur = useCallback(() => {
      setIsFocused(false)
    }, [])
    const focusProgress = useRef(new Animated.Value(0)).current
    const textInputRef = useRef<TextInput>(null)
    const {pendingFiles,fileError, setFileError,
      pastedTexts,
      viewingPasted,
      viewingPastedId,
      setViewingPastedId,
      fileInputRef,
      dropZoneRef,
      handleRemoveFile,
      applyPickedFiles,
      handleWebFileChange,
      handleRemovePastedText,
      handleUpdatePastedText,
      handlePastedTextChange,
      resetAttachments,
    } = useComposerAttachments()
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
        easing: PROMINENT_COMPOSER_HEIGHT_EASING,
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

    const handleAttachClick = useCallback(() => {
      if (Platform.OS === "web") {
        fileInputRef.current?.click()
        return
      }
      setAttachSheetOpen(true)
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

    const animateProminentHeight = useCallback(
      (
        animatedValue: Animated.Value,
        toValue: number,
      duration: number,
      easing:(value: number) => number) => {
      Animated.timing(animatedValue, {
        toValue,
        duration,
        easing,
        useNativeDriver: false,
      }).start()
    }, [])

    const prominentExpansion = useProminentComposerHeight( {
      enabled:useProminentComposer,
      empty: composerEmpty,
      text: composerDisplayValue,
      inputHeight,
      minHeight:PROMINENT_COMPOSER_MIN_HEIGHT,
      lineHeight: PROMINENT_COMPOSER_LINE_HEIGHT,
      paddingTop: PROMINENT_COMPOSER_PADDING_TOP,
      paddingHorizontal: PROMINENT_COMPOSER_PADDING_HORIZONTAL,
      paddingBottom: PROMINENT_COMPOSER_PADDING_BOTTOM,
      easing: PROMINENT_COMPOSER_HEIGHT_EASING,
      inputHeightAnimation,
      setInputHeight,
      animate: animateProminentHeight,
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
      setInputHeight(inputMinHeight);
      resetAttachments()
      textInputRef.current?.focus()
    }, [value, disabled, isLoading, onSubmit, pendingFiles, pastedTexts, voiceInput.isBusy, setValue, inputMinHeight,
      resetAttachments])

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

        const pastedValue = handlePastedTextChange(valueRef.current, next)
        if (pastedValue !== null) {
          setValue(pastedValue)
          return
        }
        setValue(next)
        if (next.length === 0) {
          setInputHeight(inputMinHeight)
        }
      },
      [setValue, handlePastedTextChange, inputMinHeight]
    )

    const keyboardBorderColor = focusProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [chatgptComposer.border, chatgptComposer.borderFocus],
    })

    return (
      <View ref={ref} className={cn("w-full", className)}>
        <Animated.View
          ref={dropZoneRef as any}
          onLayout={useProminentComposer ? prominentExpansion.onPillLayout : undefined}
          className={cn(
            "relative",
            !useProminentComposer && "overflow-hidden rounded-xl border bg-card border-border/60",
          )}
          style={
            useProminentComposer
              ? {
                  overflow: "hidden" as const,
                  borderTopLeftRadius: PROMINENT_COMPOSER_RADIUS,
                  borderTopRightRadius: PROMINENT_COMPOSER_RADIUS,
                  borderBottomLeftRadius: PROMINENT_COMPOSER_RADIUS,
                  borderBottomRightRadius: PROMINENT_COMPOSER_RADIUS,
                  borderWidth: 1,
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

          <View onLayout={useProminentComposer ? prominentExpansion.onChromeLayout : undefined}>
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
          </View>

          {useProminentComposer ? (
            <Animated.View pointerEvents="none" style={prominentExpansion.spacerStyle} />
          ) : (
          <TextInput
            ref={textInputRef}
            testID="home-composer-input"
            placeholder={placeholderText}
            placeholderTextColor={chatgptComposer.placeholder}
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
            {...COMPOSER_KEYBOARD_PROPS}
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
              !useProminentComposer && isPhoneChrome && "items-end gap-y-1"
            )}
            style={useProminentComposer ? { zIndex: PROMINENT_COMPOSER_TOOLBAR_Z_INDEX } : undefined}
            pointerEvents={useProminentComposer ? "box-none" : undefined}
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
                !useProminentComposer &&
                  isPhoneChrome && "min-w-0 flex-1 flex-wrap"
              )}
              style={useProminentComposer ? { zIndex: PROMINENT_COMPOSER_CHROME_Z_INDEX } : undefined}
            >
              {useProminentComposer ? (
                <>
                <ComposerPlusTrigger
                  onPress={() => setPlusMenuOpen(true)}
                  disabled={disabled || isLoading}
                  testID="home-composer-plus"
                    color={chatgptComposer.icon}
                  />
                <ComposerPlusSheet
                  visible={plusMenuOpen}
                  onClose={closePlusMenu}
                  expandedId={plusExpandedId}
                  onToggleSection={togglePlusSection}
                  maxHeight={Math.round(windowHeight * NATIVE_PHONE_SHEET_COMPACT_RATIO)}
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
              <ComposerModelPicker{...composerModelPickerProps({currentModelId,
                effectiveIsPro,
                disabled,
                nativeSheet: isPhoneChrome,
                triggerClassName:cn(
                  useProminentComposer
                    ? "h-7 shrink-0 flex-row items-center gap-0.5 rounded-full bg-muted px-2.5"
                    : useCurrentNativeSizing
                      ? "h-8 flex-row items-center gap-1 rounded-lg border border-border/45 bg-muted/30 px-2"
                    : "h-[22px] flex-row items-center gap-1 rounded-md px-1.5",
                    isPhoneChrome && !useProminentComposer && "min-w-0"
                ),
                triggerStyle: isPhoneChrome ? { maxWidth: modelTriggerMaxWidth } : undefined,
                labelClassName:useProminentComposer
                  ? "text-[12px] text-foreground"
                  : useCurrentNativeSizing
                    ? "text-[13px] text-foreground"
                    : "text-xs text-muted-foreground",
                chevronSize:useCurrentNativeSizing ? 10 : 8,
                chevronColor:useProminentComposer ? chatgptComposer.icon : undefined,
                chevronStrokeWidth:useProminentComposer ? NATIVE_PHONE_ICON_STROKE : undefined,
                hitSlop:useCurrentNativeSizing ? 6 : undefined,
                label: isPhoneChrome ? compactNativeModelLabel(currentModelId) : resolveShortName(currentModelId),
                menuWidth:nativeModelMenuWidth,
                onSelect:handleModelChange})}
              />
            </View>

            {useProminentComposer ? (
              <View
                pointerEvents="none"
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: PROMINENT_COMPOSER_MIN_HEIGHT,
                  marginLeft: 4,
                  marginRight: 4,
                }}
                onLayout={prominentExpansion.onCompactSlotLayout}
              />
            ) : null}

            {/* Right side buttons */}
            {voiceInput.isRecording ? (
              <View className={cn("flex-row flex-shrink-0 items-center", useProminentComposer ? "gap-1.5" : useCurrentNativeSizing ? "gap-1.5" : "gap-2")} style={useProminentComposer ? { zIndex: PROMINENT_COMPOSER_CHROME_Z_INDEX } : undefined}>
                <VoiceWaveform />
                <Pressable
                  onPress={() => voiceInput.toggleRecording().catch(() => {})}
                  hitSlop={useCurrentNativeSizing ? 4 : undefined}
                  role="button"
                  accessibilityLabel="Stop voice recording"
                  className={cn(
                    "rounded-full bg-foreground/90 items-center justify-center active:opacity-70",
                    useProminentComposer || useCurrentNativeSizing ? sendChrome.sizeClassName : "h-6 w-6",
                  )}
                >
                  <Square className="text-background" size={useProminentComposer ? 10 : useCurrentNativeSizing ? 14 : 10} fill="currentColor" />
                </Pressable>
              </View>
            ) : (
              <View className={cn("flex-row flex-shrink-0 items-center", useProminentComposer ? "ml-1 gap-1" : useCurrentNativeSizing ? "ml-1 gap-1" : "gap-1")} style={useProminentComposer ? { zIndex: PROMINENT_COMPOSER_CHROME_Z_INDEX } : undefined}>
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
                <ComposerSendButton
                  canSend={Boolean(value.trim() || pendingFiles.length > 0 || pastedTexts.length > 0)}
                  onPress={handleSubmit}
                  disabled={disabled}
                  loading={isLoading}
                  prominent={useProminentComposer}
                  sizeClassName={sendChrome.sizeClassName}
                  iconSize={sendChrome.iconSize}
                  fillClassName={useProminentComposer ? "": "bg-primary" }
                  iconClassName={useProminentComposer ? "" : "text-primary-foreground"}
                  fillColor={useProminentComposer ? chatgptComposer.sendFill : undefined}
                  iconColor={useProminentComposer ? chatgptComposer.sendIcon : undefined}
                    />
                {!isLoading &&
                !(
                  value.trim() ||
                  pendingFiles.length> 0 ||
                  pastedTexts.length > 0
                ) && onStartVoiceProjectCreation ? (
                  <>
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
                      color={useProminentComposer ?disabled ? chatgptComposer.placeholder : chatgptComposer.icon : undefined}
                      strokeWidth={useProminentComposer ? NATIVE_PHONE_ICON_STROKE : undefined}
                      size={useProminentComposer ? 20 : useCurrentNativeSizing ? 18 : 14}
                    />
                  </Pressable>
                  </>
                ) : !isLoading &&
                  !(
                    value.trim() ||
                    pendingFiles.length > 0 ||
                    pastedTexts.length > 0
                  ) && voiceInput.canRecord ? (
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
                      color={useProminentComposer ?disabled ? chatgptComposer.placeholder : chatgptComposer.icon : undefined}
                      strokeWidth={useProminentComposer ? NATIVE_PHONE_ICON_STROKE : undefined}
                      size={useProminentComposer ? 20 : useCurrentNativeSizing ? 18 : 14}
                    />
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>

          {useProminentComposer ? (
            <ProminentComposerField
              ref={textInputRef}
              value={composerDisplayValue}
              placeholder={placeholderText}
              empty={composerEmpty}
              stacked={prominentExpansion.stacked}
              disabled={disabled || isLoading || voiceInput.isRecording}
              dimWhenDisabled={dimWhenDisabled}
              inputHeight={inputHeight}
              inputHeightAnimation={inputHeightAnimation}
              slotStyle={prominentExpansion.slotStyle}
              inputComponent={TextInput}
              textColor={chatgptComposer.text}
              placeholderColor={chatgptComposer.placeholder}
              onMeasureTextLayout={prominentExpansion.onMeasureTextLayout}
              testID="home-composer-input"
              accessibilityLabel="Describe the agent you want to build"
              onChangeText={handleChangeText}
              onFocus={handleComposerFocus}
              onBlur={handleComposerBlur}
              onSubmitEditing={handleSubmitEditing}
              onKeyPress={(e: any) => {
                if (
                  Platform.OS === "web" &&
                  e.nativeEvent.key === "Enter" &&
                  !e.nativeEvent.shiftKey
                ) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              scrollEnabled={
                prominentExpansion.stacked &&
                inputHeight > PROMINENT_COMPOSER_MIN_HEIGHT
              }
              onContentSizeChange={(e) => {
                const h = e.nativeEvent.contentSize.height
                prominentExpansion.reportContentHeight(h)
                const next = nextProminentComposerHeight(h, {
                  empty: composerEmpty,
                  minHeight: PROMINENT_COMPOSER_MIN_HEIGHT,
                  maxHeight: inputMaxHeight,
                  lineHeight: PROMINENT_COMPOSER_LINE_HEIGHT,
                })
                if (next !== inputHeight) {
                  setInputHeight(next)
                }
              }}
            />
          ) : null}
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

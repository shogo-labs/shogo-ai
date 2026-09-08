// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Redesigned model picker menu (shared by ChatInput and CompactChatInput).
 *
 * Layout matches the product spec: a single flat, admin-ordered list with the
 * "Auto" option pinned on top. Each row shows the model name and its reasoning
 * effort label. On web, hovering a row reveals a side info panel (description,
 * context window, reasoning effort); on native the same details expand inline.
 * Super admins get a "Manage models" footer that routes to admin settings.
 *
 * Model order + metadata come from `useModelPickerList()`, which reflects the
 * admin-configured catalog (sortOrder, description, contextWindow,
 * reasoningEffort) served by `/api/platform/visible-models`.
 */
import React, { useCallback, useState } from "react"
import { View, Text, Pressable, ScrollView, Platform, useWindowDimensions, Keyboard, type StyleProp, type ViewStyle } from "react-native"
import { useRouter } from "expo-router"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check, Lock, Settings2, ChevronRight, ChevronDown } from "lucide-react-native"
import { AutoModelOption } from "./AutoModelOption"
import {
  useModelPickerList,
  type PickerModel,
  type ReasoningEffort,
} from "../../lib/visible-models"
import { useIsSuperAdmin } from "../../lib/use-is-super-admin"
import { NativeActivitySheet } from "./NativeActivitySheet"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"

/** Compact label shown on each row (right side). */
const EFFORT_SHORT: Record<ReasoningEffort, string> = {
  off: "Instant",
  minimal: "Fast",
  low: "Fast",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
}

/** Word used in the info panel ("medium effort"). */
const EFFORT_WORD: Record<ReasoningEffort, string> = {
  off: "no",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "maximum",
}

function formatContextWindow(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k context window`
  return `${tokens} context window`
}

/** Width of the detached web info card that floats beside the list on hover. */
const INFO_PANEL_WIDTH = 232
const WEB_MENU_WIDTH = 280

export function getNativeModelMenuWidth(windowWidth: number): number {
  return Math.max(240, Math.min(WEB_MENU_WIDTH, Math.floor(windowWidth - 32)))
}

function ModelInfoPanel({ model }: { model: PickerModel }) {
  const context = formatContextWindow(model.contextWindow)
  return (
    <View className="p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">{model.displayName}</Text>
      {model.description ? (
        <Text className="text-xs text-muted-foreground leading-5">{model.description}</Text>
      ) : null}
      {context ? <Text className="text-xs text-muted-foreground">{context}</Text> : null}
      {model.reasoningEffort ? (
        <Text className="text-xs italic text-muted-foreground">
          Reasoning: {EFFORT_WORD[model.reasoningEffort]} effort
        </Text>
      ) : null}
    </View>
  )
}

interface ModelPickerMenuProps {
  currentModelId: string
  /** When false, non-economy tiers render locked. */
  effectiveIsPro: boolean
  /** Called with the chosen model id (or AUTO_MODEL_ID). */
  onSelect: (modelId: string) => void
  /** Close the wrapping sheet/popover (e.g. before routing to admin). */
  onDismiss?: () => void
  /** Full-width list for the native bottom sheet (no nested scroll/width cap). */
  presentation?: "menu" | "sheet"
}

export function ModelPickerMenu({
  currentModelId,
  effectiveIsPro,
  onSelect,
  onDismiss,
  presentation = "menu",
}: ModelPickerMenuProps) {
  const router = useRouter()
  const models = useModelPickerList()
  const isAdmin = useIsSuperAdmin()
  const isWeb = Platform.OS === "web"
  const isSheet = presentation === "sheet"
  const { width: windowWidth } = useWindowDimensions()
  const menuWidth = isSheet ? undefined : isWeb ? WEB_MENU_WIDTH : getNativeModelMenuWidth(windowWidth)

  // Web: which row is hovered (drives the side info panel). Native: which row
  // is expanded inline (tap the chevron to toggle).
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Only surface the side info card when a row is actively hovered — it should
  // not default to the current model when the menu first opens.
  const activeInfoModel = hoveredId ? (models.find((m) => m.id === hoveredId) ?? null) : null

  const renderRow = (model: PickerModel) => {
    const isSelected = currentModelId === model.id
    const isLocked = !effectiveIsPro && model.tier !== "economy"
    const effort = model.reasoningEffort
    const isExpanded = expandedId === model.id
    const hasDetails = !!(model.description || model.contextWindow || model.reasoningEffort)

    return (
      <View key={model.id}>
        <Pressable
          onPress={() => onSelect(model.id)}
          onHoverIn={isWeb ? () => setHoveredId(model.id) : undefined}
          onHoverOut={isWeb ? () => setHoveredId((id) => (id === model.id ? null : id)) : undefined}
          className={cn(
            "flex-row items-center gap-2.5 px-3",
            isSheet ? "min-h-14 py-3" : isWeb ? "py-2" : "min-h-12 py-2.5",
            isSelected && "bg-accent",
            isLocked && "opacity-50",
          )}
        >
          <View className="flex-1 flex-row items-baseline gap-1.5">
            <Text className={cn(isWeb ? "text-sm" : "text-base", isLocked ? "text-muted-foreground" : "text-foreground")}>
              {model.shortDisplayName ?? model.displayName}
            </Text>
            {effort ? (
              <Text className={isWeb ? "text-[11px] text-muted-foreground" : "text-xs text-muted-foreground"}>{EFFORT_SHORT[effort]}</Text>
            ) : null}
          </View>
          {isLocked ? (
            <Lock className="text-muted-foreground" size={isWeb ? 12 : 17} />
          ) : isSelected ? (
            <Check className="text-primary" size={isWeb ? 14 : 18} />
          ) : null}
          {/* Native-only inline details toggle. */}
          {!isWeb && hasDetails ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.()
                setExpandedId((prev) => (prev === model.id ? null : model.id))
              }}
              hitSlop={8}
              className="pl-1"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground/60",
                  isExpanded && "rotate-90",
                )}
                size={18}
              />
            </Pressable>
          ) : null}
        </Pressable>
        {!isWeb && isExpanded ? (
          <View className="px-3 pb-2.5 -mt-1 gap-1">
            {model.description ? (
              <Text className="text-[13px] text-muted-foreground leading-5">{model.description}</Text>
            ) : null}
            {formatContextWindow(model.contextWindow) ? (
              <Text className="text-[13px] text-muted-foreground">
                {formatContextWindow(model.contextWindow)}
              </Text>
            ) : null}
            {effort ? (
              <Text className="text-[13px] italic text-muted-foreground">
                Reasoning: {EFFORT_WORD[effort]} effort
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    )
  }

  const rows = (
    <>
      <AutoModelOption
        currentModelId={currentModelId}
        presentation={presentation}
        onSelect={() => onSelect(AUTO_MODEL_ID)}
      />
      <View className="h-px bg-border/50 mx-2" />
      {models.map(renderRow)}
    </>
  )

  const list = (
    <View style={isSheet ? { width: "100%" } : { width: menuWidth }}>
      {isSheet ? (
        rows
      ) : (
        <ScrollView
          style={{ maxHeight: 340 }}
          showsVerticalScrollIndicator={!isWeb}
          nestedScrollEnabled={!isWeb}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={!isWeb ? { paddingBottom: 8 } : undefined}
        >
          {rows}
        </ScrollView>
      )}
      {isAdmin ? (
        <Pressable
          onPress={() => {
            onDismiss?.()
            router.push("/(admin)/settings" as any)
          }}
          onHoverIn={isWeb ? () => setHoveredId(null) : undefined}
          className="flex-row items-center gap-2 px-3 py-2.5 border-t border-border/50"
        >
          <Settings2 className="h-3.5 w-3.5 text-muted-foreground" size={14} />
          <Text className="text-xs text-muted-foreground">Manage models</Text>
        </Pressable>
      ) : null}
    </View>
  )

  if (!isWeb) return list

  return (
    // The list is the popover body; the info card is a separate floating piece
    // anchored to the list's right edge, so it isn't clipped by the menu's
    // width and only appears while a row is hovered. `userSelect: none` stops
    // click-drag text highlighting; `outline-none` kills the focus ring.
    <View
      className="relative web:outline-none no-focus-ring"
      style={{ userSelect: "none" } as any}
    >
      {list}
      {activeInfoModel ? (
        <View
          className="bg-card border border-border rounded-lg shadow-lg"
          style={{ position: "absolute", left: "100%", top: 0, marginLeft: 8, width: INFO_PANEL_WIDTH }}
        >
          <ModelInfoPanel model={activeInfoModel} />
        </View>
      ) : null}
    </View>
  )
}

function ModelPickerTrigger({
  disabled,
  hitSlop,
  triggerClassName,
  triggerStyle,
  labelClassName,
  label,
  chevronSize,
  onPress,
  pressableProps,
}: {
  disabled?: boolean
  hitSlop?: number
  triggerClassName: string
  triggerStyle?: StyleProp<ViewStyle>
  labelClassName: string
  label: string
  chevronSize: number
  onPress?: () => void
  pressableProps?: Record<string, unknown>
}) {
  return (
    <Pressable
      {...pressableProps}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel="Choose model"
      className={triggerClassName}
      style={triggerStyle}
      {...(onPress ? { onPress } : {})}
    >
      <Text className={labelClassName} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown className="flex-shrink-0 text-muted-foreground/70" size={chevronSize} />
    </Pressable>
  )
}

export function ComposerModelPicker({
  currentModelId,
  effectiveIsPro,
  disabled,
  nativeSheet,
  triggerClassName,
  labelClassName,
  triggerStyle,
  chevronSize,
  hitSlop,
  label,
  menuWidth,
  onSelect,
}: {
  currentModelId: string
  effectiveIsPro: boolean
  disabled?: boolean
  nativeSheet: boolean
  triggerClassName: string
  labelClassName: string
  triggerStyle?: StyleProp<ViewStyle>
  chevronSize: number
  hitSlop?: number
  label: string
  menuWidth?: number
  onSelect: (modelId: string) => void
}) {
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback((modelId: string) => {
    onSelect(modelId)
    setOpen(false)
  }, [onSelect])

  const close = useCallback(() => setOpen(false), [])

  const menu = (
    <ModelPickerMenu
      currentModelId={currentModelId}
      effectiveIsPro={effectiveIsPro}
      presentation={nativeSheet ? "sheet" : "menu"}
      onSelect={handleSelect}
      onDismiss={close}
    />
  )

  const triggerProps = {
    disabled,
    hitSlop,
    triggerClassName,
    triggerStyle,
    labelClassName,
    label,
    chevronSize,
  }

  if (nativeSheet) {
    return (
      <>
        <ModelPickerTrigger
          {...triggerProps}
          onPress={() => {
            Keyboard.dismiss()
            setOpen(true)
          }}
        />
        <NativeActivitySheet visible={open} title="Model" onClose={close}>
          {menu}
        </NativeActivitySheet>
      </>
    )
  }

  return (
    <Popover
      placement="top"
      size="xs"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={close}
      trigger={(popoverTriggerProps) => (
        <ModelPickerTrigger
          {...triggerProps}
          pressableProps={popoverTriggerProps as Record<string, unknown>}
        />
      )}
    >
      <PopoverBackdrop />
      <PopoverContent
        className="p-0 max-h-[360px] web:outline-none web:overflow-visible web:max-w-none"
        style={menuWidth ? { width: menuWidth } : undefined}
      >
        {menu}
      </PopoverContent>
    </Popover>
  )
}


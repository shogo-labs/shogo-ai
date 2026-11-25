// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Redesigned model picker menu (used by ChatInput).
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
import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  useWindowDimensions,
  Keyboard,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native"
import { useRouter } from "expo-router"
import { cn } from "@shogo/shared-ui/primitives"
import { UPGRADE_PLAN_NAME } from "@/lib/billing-config"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check, Lock, Settings2, ChevronRight, ChevronDown } from "lucide-react-native"
import { AutoModelOption } from "./AutoModelOption"
import { useModelPickerList, type PickerModel, type ReasoningEffort } from "../../lib/visible-models"
import { useIsSuperAdmin } from "../../lib/use-is-super-admin"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import { NativeActivitySheet } from "./NativeActivitySheet"
import { NATIVE_PHONE_SECTION_INSET } from "../../lib/native-phone-layout"
import { modelPickerHidesCostLabels } from "../../lib/model-build-cost"
import { NATIVE_MODEL_SHEET } from "./model-picker-sheet-chrome"
import { Popover, PopoverBackdrop, PopoverContent } from "@/components/ui/popover"

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
/** Height cap of the web model list; the info card clamps to the same span. */
const WEB_LIST_MAX_HEIGHT = 340

export function getNativeModelMenuWidth(windowWidth: number): number {
  return Math.max(240, Math.min(WEB_MENU_WIDTH, Math.floor(windowWidth - NATIVE_PHONE_SECTION_INSET)))
}

function ModelInfoPanel({ model }: { model: PickerModel }) {
  const context = formatContextWindow(model.contextWindow)
  return (
    <View className="p-4 gap-3">
      <Text className="text-sm font-semibold text-foreground">{model.displayName}</Text>
      {model.description ? <Text className="text-xs text-muted-foreground leading-5">{model.description}</Text> : null}
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
  /** Plan pickers and the native phone sheet show names only. */
  hideCostLabels?: boolean
}

export function ModelPickerMenu({
  currentModelId,
  effectiveIsPro,
  onSelect,
  onDismiss,
  presentation = "menu",
  hideCostLabels = false,
}: ModelPickerMenuProps) {
  const router = useRouter()
  const models = useModelPickerList()
  const isAdmin = useIsSuperAdmin()
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
  const isWeb = Platform.OS === "web"
  const isSheet = presentation === "sheet"
  const namesOnly = modelPickerHidesCostLabels(hideCostLabels, presentation)
  const { width: windowWidth } = useWindowDimensions()
  const menuWidth = isSheet ? undefined : isWeb ? WEB_MENU_WIDTH : getNativeModelMenuWidth(windowWidth)

  // Web: which row is hovered (drives the side info panel). Native: which row
  // is expanded inline (tap the chevron to toggle).
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const hoverClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isWeb) setExpandedId(currentModelId)
  }, [currentModelId, isWeb])
  useEffect(() => () => {
    if (hoverClearTimer.current) clearTimeout(hoverClearTimer.current)
  }, [])

  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimer.current) clearTimeout(hoverClearTimer.current)
    hoverClearTimer.current = null
  }, [])

  const scheduleHoverClear = useCallback((modelId: string) => {
    cancelHoverClear()
    hoverClearTimer.current = setTimeout(() => {
      setHoveredId((current) => (current === modelId ? null : current))
      hoverClearTimer.current = null
    }, 120)
  }, [cancelHoverClear])

  // Web hover card geometry, all measured rather than assumed: each row's
  // offset inside the scroll content, the list's scroll offset and viewport
  // height, and the card's own height. A guessed row height drifted a few px
  // per row and, worse, ignored the scroll offset entirely, so after scrolling
  // the card sat below the row it described (SHO-480).
  const [webRowBoxes, setWebRowBoxes] = useState<Record<string, { y: number; height: number }>>({})
  const [webScrollTop, setWebScrollTop] = useState(0)
  const [webViewportHeight, setWebViewportHeight] = useState(0)
  const [webCardHeight, setWebCardHeight] = useState(0)

  const handleRowLayout = useCallback((modelId: string, event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout
    setWebRowBoxes((prev) => {
      const current = prev[modelId]
      if (current && current.y === y && current.height === height) return prev
      return { ...prev, [modelId]: { y, height } }
    })
  }, [])

  const handleListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setWebScrollTop(event.nativeEvent.contentOffset?.y ?? 0)
  }, [])

  // Only surface the side info card when a row is actively hovered — it should
  // not default to the current model when the menu first opens.
  const activeInfoModel = hoveredId ? (models.find((m) => m.id === hoveredId) ?? null) : null
  const activeInfoBox = activeInfoModel ? webRowBoxes[activeInfoModel.id] : undefined
  const infoViewportHeight = webViewportHeight || WEB_LIST_MAX_HEIGHT
  // The card is positioned on the outer wrapper, whose top is the list's top,
  // so the row's content offset minus the scroll offset is where it belongs —
  // clamped to the visible list so it never floats above or below it.
  const activeInfoTop = activeInfoBox
    ? Math.min(
        Math.max(activeInfoBox.y - webScrollTop, 0),
        Math.max(0, infoViewportHeight - webCardHeight),
      )
    : 0
  // A row scrolled clear of the viewport leaves no row to sit beside.
  const activeInfoRowVisible =
    !!activeInfoBox &&
    activeInfoBox.y + activeInfoBox.height > webScrollTop &&
    activeInfoBox.y < webScrollTop + infoViewportHeight

  const renderRow = (model: PickerModel) => {
    const isSelected = currentModelId === model.id
    const isLocked = !effectiveIsPro && model.tier !== "economy"
    const effort = model.reasoningEffort
    const isExpanded = expandedId === model.id
    const contextLabel = !isWeb && isExpanded ? formatContextWindow(model.contextWindow) : null
    return (
      <View
        key={model.id}
        onLayout={isWeb ? (event) => handleRowLayout(model.id, event) : undefined}
      >
        <Pressable
          onPress={() => onSelect(model.id)}
          testID={`model-option-${model.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${model.shortDisplayName ?? model.displayName}${isLocked ? `, requires ${UPGRADE_PLAN_NAME}` : ""}`}
          aria-selected={isSelected}
          onHoverIn={isWeb ? () => {
            cancelHoverClear()
            setHoveredId(model.id)
          } : undefined}
          onHoverOut={isWeb ? () => scheduleHoverClear(model.id) : undefined}
          className={cn(
            "flex-row items-center gap-2.5 px-3",
            isSheet ? NATIVE_MODEL_SHEET.rowClass : isWeb ? "py-2" : "min-h-12 py-2.5",
            (isWeb ? hoveredId === model.id : isSelected) && "bg-accent",
            isLocked && "opacity-50"
          )}
        >
          <View className="flex-1 flex-row items-baseline gap-1.5">
            <Text
              className={cn(
                isSheet ? NATIVE_MODEL_SHEET.nameClass : isWeb ? "text-sm" : "text-base",
                isLocked ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {model.shortDisplayName ?? model.displayName}
            </Text>
            {effort ? (
              <Text
                className={cn(
                  "text-muted-foreground",
                  isSheet ? NATIVE_MODEL_SHEET.metaClass : isWeb ? "text-[11px]" : "text-xs",
                )}
              >
                {EFFORT_SHORT[effort]}
              </Text>
            ) : null}
          </View>
          {isLocked ? (
            <Lock className="text-muted-foreground" size={isSheet ? NATIVE_MODEL_SHEET.icon : isWeb ? 12 : 17} />
          ) : isSelected ? (
            <Check
              className={isWeb ? "text-foreground/80" : "text-primary"}
              size={isSheet ? NATIVE_MODEL_SHEET.icon : isWeb ? 14 : 18}
            />
          ) : null}
          {/* Native-only inline details toggle. */}
          {!isWeb ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.()
                setExpandedId((prev) => (prev === model.id ? null : model.id))
              }}
              hitSlop={8}
              className="pl-1"
            >
              <ChevronRight
                className={cn("flex-shrink-0 text-muted-foreground/60", isExpanded && "rotate-90")}
                size={isSheet ? NATIVE_MODEL_SHEET.icon : 18}
              />
            </Pressable>
          ) : null}
        </Pressable>
        {!isWeb && isExpanded ? (
          <View className="px-3 pb-2.5 -mt-1 gap-1">
            {model.description ? (
              <Text className={cn("text-muted-foreground", isSheet ? NATIVE_MODEL_SHEET.detailClass : "text-[13px] leading-5")}>
                {model.description}
              </Text>
            ) : null}
            {contextLabel ? (
              <Text className={cn("text-muted-foreground", isSheet ? NATIVE_MODEL_SHEET.detailClass : "text-[13px]")}>
                {contextLabel}
              </Text>
            ) : null}
            {effort ? (
              <Text className={cn("italic text-muted-foreground", isSheet ? NATIVE_MODEL_SHEET.detailClass : "text-[13px]")}>
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
          testID="model-picker-scroll"
          style={{ maxHeight: WEB_LIST_MAX_HEIGHT }}
          onScroll={isWeb ? handleListScroll : undefined}
          scrollEventThrottle={isWeb ? 16 : undefined}
          onLayout={
            isWeb ? (event) => setWebViewportHeight(event.nativeEvent.layout.height) : undefined
          }
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
            router.push(
              usesMobileWorkspaceChrome
                ? ("/(app)/ai-models" as any)
                : ("/(admin)/admin/settings" as any)
            )
          }}
          onHoverIn={isWeb ? () => {
            cancelHoverClear()
            setHoveredId(null)
          } : undefined}
          className="flex-row items-center gap-2 px-3 py-2.5 border-t border-border/50"
        >
          <Settings2
            className="flex-shrink-0 text-muted-foreground"
            size={isSheet ? NATIVE_MODEL_SHEET.manageIcon : 14}
          />
          <Text className={cn("text-muted-foreground", isSheet ? NATIVE_MODEL_SHEET.metaClass : "text-xs")}>
            Manage models
          </Text>
        </Pressable>
      ) : null}
    </View>
  )

  if (!isWeb) return list

  return (
    // The list is the popover body; the info card floats to its left so it
    // stays on-screen for the composer picker, which is anchored at the lower
    // right edge of the viewport. `userSelect: none` stops click-drag text
    // highlighting; `outline-none` kills the focus ring.
    <View className="relative web:outline-none no-focus-ring" style={{ userSelect: "none" } as any}>
      {list}
      {activeInfoModel && !namesOnly && activeInfoRowVisible ? (
        <View
          testID="model-info-card"
          onLayout={(event) => setWebCardHeight(event.nativeEvent.layout.height)}
          {...(isWeb ? {
            onMouseEnter: cancelHoverClear,
            onMouseLeave: () => scheduleHoverClear(activeInfoModel.id),
          } as any : {})}
          className="bg-card border border-border rounded-xl shadow-lg"
          style={{
            position: "absolute",
            right: "100%",
            top: activeInfoTop,
            marginRight: 8,
            width: INFO_PANEL_WIDTH,
          }}
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
  labelSuffix,
  labelSuffixClassName,
  chevronSize,
  chevronColor,
  chevronStrokeWidth,
  onPress,
  pressableProps,
  accessibilityLabel = "Choose model",
}: {
  disabled?: boolean
  hitSlop?: number
  triggerClassName: string
  triggerStyle?: StyleProp<ViewStyle>
  labelClassName: string
  label: string
  labelSuffix?: string
  labelSuffixClassName?: string
  chevronSize: number
  chevronColor?: string
  chevronStrokeWidth?: number
  onPress?: () => void
  pressableProps?: Record<string, unknown>
  accessibilityLabel?: string
}) {
  return (
    <Pressable
      {...pressableProps}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={triggerClassName}
      style={triggerStyle}
      {...(onPress ? { onPress } : {})}
    >
      <Text className={labelClassName} numberOfLines={1}>
        {label}
      </Text>
      {labelSuffix ? (
        <Text className={labelSuffixClassName} numberOfLines={1}>
          {labelSuffix}
        </Text>
      ) : null}
      <ChevronDown
        className={chevronColor ? "flex-shrink-0" : "flex-shrink-0 text-muted-foreground/70"}
        color={chevronColor}
        strokeWidth={chevronStrokeWidth}
        size={chevronSize}
      />
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
  chevronColor,
  chevronStrokeWidth,
  hitSlop,
  label,
  labelSuffix,
  labelSuffixClassName,
  menuWidth,
  onSelect,
  sheetTitle,
  triggerAccessibilityLabel,
  hideCostLabels = false,
}: {
  currentModelId: string
  effectiveIsPro: boolean
  disabled?: boolean
  nativeSheet: boolean
  triggerClassName: string
  labelClassName: string
  triggerStyle?: StyleProp<ViewStyle>
  chevronSize: number
  chevronColor?: string
  chevronStrokeWidth?: number
  hitSlop?: number
  label: string
  labelSuffix?: string
  labelSuffixClassName?: string
  menuWidth?: number
  sheetTitle?: string
  triggerAccessibilityLabel?: string
  hideCostLabels?: boolean
  onSelect: (modelId: string) => void
}) {
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback(
    (modelId: string) => {
      onSelect(modelId)
      setOpen(false)
    },
    [onSelect]
  )

  const close = useCallback(() => setOpen(false), [])

  const menu = (
    <ModelPickerMenu
      currentModelId={currentModelId}
      effectiveIsPro={effectiveIsPro}
      presentation={nativeSheet ? "sheet" : "menu"}
      hideCostLabels={hideCostLabels}
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
    labelSuffix,
    labelSuffixClassName,
    chevronSize,
    chevronColor,
    chevronStrokeWidth,
    accessibilityLabel: triggerAccessibilityLabel,
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
        <NativeActivitySheet visible={open} title={sheetTitle ?? "Model"} onClose={close} showClose={false}>
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
        <ModelPickerTrigger {...triggerProps} pressableProps={popoverTriggerProps as Record<string, unknown>} />
      )}
    >
      <PopoverBackdrop />
      <PopoverContent
        className="p-0 max-h-[360px] rounded-xl web:outline-none web:overflow-visible web:max-w-none"
        style={menuWidth ? { width: menuWidth } : undefined}
      >
        {menu}
      </PopoverContent>
    </Popover>
  )
}

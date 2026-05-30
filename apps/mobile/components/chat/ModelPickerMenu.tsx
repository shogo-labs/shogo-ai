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
import React, { useState } from "react"
import { View, Text, Pressable, ScrollView, Platform } from "react-native"
import { useRouter } from "expo-router"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check, Lock, Settings2, ChevronRight } from "lucide-react-native"
import { AutoModelOption } from "./AutoModelOption"
import {
  useModelPickerList,
  type PickerModel,
  type ReasoningEffort,
} from "../../lib/visible-models"
import { useIsSuperAdmin } from "../../lib/use-is-super-admin"

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

function ModelInfoPanel({ model }: { model: PickerModel | null }) {
  if (!model) {
    return (
      <View className="flex-1 p-4 justify-center">
        <Text className="text-xs text-muted-foreground">Hover a model for details.</Text>
      </View>
    )
  }
  const context = formatContextWindow(model.contextWindow)
  return (
    <View className="flex-1 p-4 gap-3">
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
}

export function ModelPickerMenu({
  currentModelId,
  effectiveIsPro,
  onSelect,
}: ModelPickerMenuProps) {
  const router = useRouter()
  const models = useModelPickerList()
  const isAdmin = useIsSuperAdmin()
  const isWeb = Platform.OS === "web"

  // Web: which row is hovered (drives the side info panel). Native: which row
  // is expanded inline (tap the chevron to toggle).
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const activeInfoModel =
    models.find((m) => m.id === (hoveredId ?? currentModelId)) ?? null

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
          className={cn(
            "flex-row items-center gap-2.5 px-3 py-2",
            isSelected && "bg-accent",
            isLocked && "opacity-50",
          )}
        >
          <View className="flex-1 flex-row items-baseline gap-1.5">
            <Text className={cn("text-sm", isLocked ? "text-muted-foreground" : "text-foreground")}>
              {model.shortDisplayName ?? model.displayName}
            </Text>
            {effort ? (
              <Text className="text-[11px] text-muted-foreground">{EFFORT_SHORT[effort]}</Text>
            ) : null}
          </View>
          {isLocked ? (
            <Lock className="h-3 w-3 text-muted-foreground" size={12} />
          ) : isSelected ? (
            <Check className="h-3.5 w-3.5 text-primary" size={14} />
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
                size={14}
              />
            </Pressable>
          ) : null}
        </Pressable>
        {!isWeb && isExpanded ? (
          <View className="px-3 pb-2.5 -mt-1 gap-1">
            {model.description ? (
              <Text className="text-[11px] text-muted-foreground leading-4">{model.description}</Text>
            ) : null}
            {formatContextWindow(model.contextWindow) ? (
              <Text className="text-[11px] text-muted-foreground">
                {formatContextWindow(model.contextWindow)}
              </Text>
            ) : null}
            {effort ? (
              <Text className="text-[11px] italic text-muted-foreground">
                Reasoning: {EFFORT_WORD[effort]} effort
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    )
  }

  const list = (
    <View style={isWeb ? { width: 280 } : undefined}>
      <ScrollView style={{ maxHeight: 340 }}>
        <AutoModelOption
          currentModelId={currentModelId}
          onSelect={() => onSelect(AUTO_MODEL_ID)}
        />
        <View className="h-px bg-border/50 mx-2" />
        {models.map(renderRow)}
      </ScrollView>
      {isAdmin ? (
        <Pressable
          onPress={() => router.push("/(admin)/settings" as any)}
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
    <View className="flex-row">
      {list}
      <View className="w-px bg-border/50" />
      <ModelInfoPanel model={activeInfoModel} />
    </View>
  )
}

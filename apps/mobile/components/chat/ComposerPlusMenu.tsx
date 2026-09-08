// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import { View, Text, Pressable, Modal, ScrollView } from "react-native"
import { Camera, ChevronDown, ChevronUp, FolderOpen, Image as ImageIcon, Languages } from "lucide-react-native"
import type { NativeAttachAction } from "../../lib/native-attachment-picker"
import { resolveShortName } from "../../lib/visible-models"
import { cn } from "@shogo/shared-ui/primitives"

export const ComposerPlusCloseContext = createContext<(() => void) | null>(null)

export function useComposerPlusClose() {
  return useContext(ComposerPlusCloseContext)
}

/** ChatGPT iOS composer tokens (App Store 1.2026 + OpenAI product palette). */
export const CHATGPT_COMPOSER = {
  light: {
    fill: "#ffffff",
    border: "#e5e5e5",
    borderFocus: "#cfcfcf",
    text: "#0d0d0d",
    placeholder: "#8e8e8e",
    icon: "#0d0d0d",
    sendFill: "#0d0d0d",
    sendIcon: "#ffffff",
  },
  dark: {
    fill: "#212121",
    border: "rgba(255,255,255,0.08)",
    borderFocus: "rgba(255,255,255,0.16)",
    text: "#ececec",
    placeholder: "#8e8e8e",
    icon: "#ececec",
    sendFill: "#ffffff",
    sendIcon: "#0d0d0d",
  },
} as const

export const PLUS_ATTACH_ROWS: {
  action: NativeAttachAction
  label: string
  hint: string
  Icon: typeof Camera
}[] = [
  { action: "documents", label: "Browse files", hint: "Any file type", Icon: FolderOpen },
  { action: "camera", label: "Take photo", hint: "Use your camera", Icon: Camera },
  { action: "library", label: "Photo library", hint: "Pick from your gallery", Icon: ImageIcon },
]

export const PlusAccordionContext = createContext<{
  expandedId: string | null
  toggle: (id: string) => void
} | null>(null)

export function ComposerPlusSection({
  id,
  label,
  value,
  Icon,
  children,
}: {
  id: string
  label: string
  value?: string
  Icon: ComponentType<{ size?: number; className?: string }>
  children: ReactNode
}) {
  const ctx = useContext(PlusAccordionContext)
  const expanded = ctx?.expandedId === id
  return (
    <View className="border-b border-border/40">
      <Pressable
        onPress={() => ctx?.toggle(id)}
        className="flex-row items-center gap-3 px-3 py-3 active:bg-muted/50"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
      >
        <View className="h-8 w-8 items-center justify-center rounded-lg bg-muted/40">
          <Icon size={16} className="text-foreground" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground">{label}</Text>
          {value ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {value}
            </Text>
          ) : null}
        </View>
        <View className="h-4 w-4 shrink-0 items-center justify-center">
          {expanded ? (
            <ChevronUp size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </View>
      </Pressable>
      {expanded ? <View className="pb-1">{children}</View> : null}
    </View>
  )
}

export function compactNativeModelLabel(modelId: string): string {
  const label = resolveShortName(modelId)
  const lower = label.toLowerCase()
  if (lower.includes("haiku")) return "Haiku"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("gemini")) return "Gemini"
  if (lower.includes("gpt")) return "GPT"
  return label.length > 12 ? `${label.slice(0, 9)}…` : label
}

type PlusModeOption<T extends string> = {
  id: T
  label: string
  description: string
  Icon: ComponentType<{ size?: number; className?: string }>
}

export function ComposerPlusModeList<T extends string>({
  modes,
  selectedId,
  onSelect,
  dualPlan = false,
  onDualPlanChange,
  dualPlanDisabled,
  dualPlanTestId,
}: {
  modes: PlusModeOption<T>[]
  selectedId: T
  onSelect: (id: T) => void
  dualPlan?: boolean
  onDualPlanChange?: (next: boolean) => void
  dualPlanDisabled?: boolean
  dualPlanTestId?: string
}) {
  return (
    <View className="py-1">
      {modes.map((mode) => {
        const isSelected = mode.id === selectedId
        return (
          <Pressable
            key={mode.id}
            onPress={() => onSelect(mode.id)}
            className={cn(
              "flex-row items-center gap-3 p-3 rounded-lg mb-1",
              isSelected && mode.id === "agent" && "bg-accent",
              isSelected && mode.id === "plan" && "border border-amber-500/35 bg-amber-500/12",
              isSelected && mode.id === "ask" && "border border-emerald-500/35 bg-emerald-500/12",
            )}
          >
            <View className="w-8 items-center">
              <mode.Icon
                className={cn(
                  "h-3.5 w-3.5",
                  isSelected && mode.id === "plan" && "text-amber-400",
                  isSelected && mode.id === "ask" && "text-emerald-400",
                  (!isSelected || mode.id === "agent") && "text-muted-foreground",
                )}
                size={14}
              />
            </View>
            <View className="flex-1">
              <Text
                className={cn(
                  "font-medium text-sm",
                  isSelected && mode.id === "plan" && "text-amber-400",
                  isSelected && mode.id === "ask" && "text-emerald-400",
                  (!isSelected || mode.id === "agent") && "text-foreground",
                )}
              >
                {mode.label}
              </Text>
              <Text className="text-xs text-muted-foreground">{mode.description}</Text>
            </View>
          </Pressable>
        )
      })}
      {selectedId === "plan" ? (
        <Pressable
          testID={dualPlanTestId}
          disabled={dualPlanDisabled}
          onPress={() => onDualPlanChange?.(!dualPlan)}
          accessibilityLabel="Also generate a stakeholder summary"
          className={cn(
            "mx-1 mb-1 flex-row items-center gap-3 rounded-lg p-3",
            dualPlan ? "border border-sky-500/35 bg-sky-500/12" : "bg-muted/40",
          )}
        >
          <View className="w-8 items-center">
            <Languages className={dualPlan ? "text-sky-400" : "text-muted-foreground"} size={14} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">Stakeholder summary</Text>
            <Text className="text-xs text-muted-foreground">
              Also generate a summary for stakeholders
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}

export function ComposerPlusSheet({
  visible,
  onClose,
  expandedId,
  onToggleSection,
  maxHeight,
  onAttach,
  attachDisabled = false,
  children,
}: {
  visible: boolean
  onClose: () => void
  expandedId: string | null
  onToggleSection: (id: string) => void
  maxHeight: number
  onAttach: (action: NativeAttachAction) => void
  attachDisabled?: boolean
  children: ReactNode
}) {
  if (!visible) return null

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute left-0 right-0 top-0 bottom-0 bg-black/50"
          onPress={onClose}
          accessibilityLabel="Dismiss menu"
        />
        <View
          className="z-10 mx-3 mb-3 overflow-hidden rounded-2xl border border-border bg-card"
          style={{ maxHeight }}
        >
          <ComposerPlusCloseContext.Provider value={onClose}>
            <PlusAccordionContext.Provider
              value={{ expandedId, toggle: onToggleSection }}
            >
              <ScrollView
                bounces={false}
                keyboardShouldPersistTaps="handled"
                style={{ maxHeight }}
              >
                {children}
                <View className="border-t border-border/50 pt-1 pb-1">
                  {PLUS_ATTACH_ROWS.map(({ action, label, hint, Icon }) => (
                    <Pressable
                      key={action}
                      onPress={() => onAttach(action)}
                      disabled={attachDisabled}
                      className="flex-row items-center gap-3 px-3 py-3 active:bg-muted/50"
                    >
                      <View className="h-8 w-8 items-center justify-center rounded-lg bg-muted/40">
                        <Icon size={16} className="text-foreground" />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm font-medium text-foreground">{label}</Text>
                        <Text className="text-xs text-muted-foreground">{hint}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            </PlusAccordionContext.Provider>
          </ComposerPlusCloseContext.Provider>
        </View>
      </View>
    </Modal>
  )
}

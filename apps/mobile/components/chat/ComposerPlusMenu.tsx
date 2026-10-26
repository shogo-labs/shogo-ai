// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import { View, Text, Pressable, Modal, ScrollView } from "react-native"
import { ChevronDown, ChevronUp } from "lucide-react-native"
import type { NativeAttachAction } from "../../lib/native-attachment-picker"
import { resolveShortName } from "../../lib/visible-models"
import { cn } from "@shogo/shared-ui/primitives"
import { useNativePhoneIconChrome, useNativePhoneSheetChrome } from "../../lib/native-phone-layout";
import { PHONE_DENSITY } from "../../lib/phone-density"
import { PLUS_ATTACH_ROWS } from "../../lib/composer-phone"
export { CHATGPT_COMPOSER, PLUS_ATTACH_ROWS } from "../../lib/composer-phone"

export const ComposerPlusCloseContext = createContext<(() => void) | null>(null)

export function useComposerPlusClose() {
  return useContext(ComposerPlusCloseContext)
}

const PlusAccordionContext = createContext<{
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
  Icon: ComponentType<{ size?: number; className?: string;
    color?: string;
    strokeWidth?: number }>
  children: ReactNode
}) {
  const ctx = useContext(PlusAccordionContext)
  const expanded = ctx?.expandedId === id
  const iconChrome = useNativePhoneIconChrome()
  return (
    <View className="border-b border-border/40">
      <Pressable
        onPress={() => ctx?.toggle(id)}
        className="min-h-12 flex-row items-center gap-3 px-3 py-3 active:bg-muted/50"
        accessibilityRole="button"
        accessibilityLabel={label}
        aria-expanded={expanded}
      >
        <View className="h-10 w-10 items-center justify-center rounded-lg bg-muted/40">
          <Icon size={PHONE_DENSITY.icon.sm} color={iconChrome.color} strokeWidth={iconChrome.strokeWidth} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className={cn(PHONE_DENSITY.text.label, "font-medium text-foreground")}>{label}</Text>
          {value ? (
            <Text className={cn(PHONE_DENSITY.text.caption, "text-muted-foreground")} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
        </View>
        <View className="h-5 w-5 shrink-0 items-center justify-center">
          {expanded ? (
            <ChevronUp size={PHONE_DENSITY.icon.sm} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={PHONE_DENSITY.icon.sm} className="text-muted-foreground" />
          )}
        </View>
      </Pressable>
      {expanded ? (
        <View className="pb-1" collapsable={false} style={{ width: "100%" }}>
          {children}
        </View>
      ) : null}
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
  const sheet = useNativePhoneSheetChrome()
  const iconChrome = useNativePhoneIconChrome()
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
          className="absolute left-0 right-0 top-0 bottom-0"
          style={sheet.backdrop}
          onPress={onClose}
          accessibilityLabel="Dismiss menu"
        />
        <View
          className="z-10 mx-3 mb-3 overflow-hidden rounded-2xl border border-border bg-card"
          style={[{ maxHeight }, sheet.panel]}
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
                      <View className="h-10 w-10 items-center justify-center rounded-lg bg-muted/40">
                        <Icon size={PHONE_DENSITY.icon.sm} color={iconChrome.color} strokeWidth={iconChrome.strokeWidth} />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn(PHONE_DENSITY.text.label, "font-medium text-foreground")}>{label}</Text>
                        <Text className={cn(PHONE_DENSITY.text.caption, "text-muted-foreground")}>{hint}</Text>
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

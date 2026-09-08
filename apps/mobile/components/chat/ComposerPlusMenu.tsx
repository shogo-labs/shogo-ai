// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import { View, Text, Pressable } from "react-native"
import { Camera, ChevronDown, ChevronUp, FolderOpen, Image as ImageIcon } from "lucide-react-native"
import type { NativeAttachAction } from "../../lib/native-attachment-picker"

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

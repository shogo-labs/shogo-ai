// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from 'react-native'
import { Sun, Moon, Monitor, RotateCcw } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useTheme } from '../../contexts/theme'
import { useAppearance } from '../../contexts/appearance'

export const FONT_SIZE_MIN = 11
export const FONT_SIZE_MAX = 24
const FONT_SIZE_DEFAULT = 14

function AppearanceSection({ title }: { title: string }) {
  return (
    <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 mt-5">
      {title}
    </Text>
  )
}

function AppearanceRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <View className="flex-row items-center justify-between gap-4 px-4 py-3 rounded-lg bg-muted/30 border border-border mb-2">
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        {description ? (
          <Text className="text-xs text-muted-foreground mt-0.5">{description}</Text>
        ) : null}
      </View>
      <View className="shrink-0">{children}</View>
    </View>
  )
}

export function AppearanceTab() {
  const { theme, setTheme } = useTheme()
  const { settings: ap, update, reset } = useAppearance()

  return (
    <View>
      <Text className="text-2xl font-bold text-foreground mb-1">Appearance</Text>
      <Text className="text-sm text-muted-foreground mb-6">
        Customize the look and feel of the Shogo interface.
      </Text>

      {/* ── Theme ── */}
      <AppearanceSection title="Theme" />
      <View className="flex-row gap-2 mb-2">
        {([
          { value: 'light' as const, label: 'Light', Icon: Sun },
          { value: 'dark' as const, label: 'Dark', Icon: Moon },
          { value: 'system' as const, label: 'System', Icon: Monitor },
        ] as const).map(({ value, label, Icon }) => (
          <Pressable
            key={value}
            onPress={() => setTheme(value)}
            className={cn(
              'flex-1 flex-col items-center gap-2 py-4 rounded-lg border',
              theme === value
                ? 'border-primary bg-primary/10'
                : 'border-border bg-muted/20'
            )}
          >
            <Icon
              size={20}
              className={theme === value ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-xs font-medium',
                theme === value ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Typography ── */}
      <AppearanceSection title="Typography" />
      <AppearanceRow label="UI Font Size" description="Font size for the Shogo interface">
        <View className="flex-row items-center gap-1.5">
          <Pressable
            onPress={() => update({ uiFontSize: FONT_SIZE_DEFAULT })}
            accessibilityLabel="Reset font size"
            className="w-7 h-7 items-center justify-center rounded border border-border active:bg-muted"
          >
            <RotateCcw size={12} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            onPress={() => update({ uiFontSize: Math.max(FONT_SIZE_MIN, ap.uiFontSize - 1) })}
            className="w-7 h-7 items-center justify-center rounded border border-border active:bg-muted"
          >
            <Text className="text-foreground text-base leading-none">−</Text>
          </Pressable>
          <Text className="text-sm font-semibold text-foreground tabular-nums w-6 text-center">
            {ap.uiFontSize}
          </Text>
          <Pressable
            onPress={() => update({ uiFontSize: Math.min(FONT_SIZE_MAX, ap.uiFontSize + 1) })}
            className="w-7 h-7 items-center justify-center rounded border border-border active:bg-muted"
          >
            <Text className="text-foreground text-base leading-none">+</Text>
          </Pressable>
        </View>
      </AppearanceRow>

      <Pressable
        onPress={reset}
        className="mt-4 py-2.5 rounded-lg border border-border items-center active:bg-muted"
      >
        <Text className="text-sm text-muted-foreground">Reset to defaults</Text>
      </Pressable>
    </View>
  )
}

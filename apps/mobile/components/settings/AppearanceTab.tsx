// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from 'react'
import { View, Pressable, Platform, Switch, TextInput } from 'react-native'
import {
  Sun as SunIcon,
  Moon as MoonIcon,
  Monitor as MonitorIcon,
  RotateCcw as RotateCcwIcon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useTheme } from '../../contexts/theme'
import { useAppearance } from '../../contexts/appearance'
import { THEME_CHOICES } from '../../lib/theme-choices'
import { playIslandSound } from '../island/island-sounds'
import {
  Text,
  useAccountSheetIcons,
} from './account-sheet-chrome'

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

interface IslandConfig {
  enabled: boolean
  autoHide: boolean
  shortcut: string
  sounds: boolean
  soundVolume: number
}

const ISLAND_VOLUME_STEPS = [
  { label: 'Low', value: 0.3 },
  { label: 'Medium', value: 0.6 },
  { label: 'High', value: 1 },
] as const

function nearestVolumeStep(volume: number): number {
  return ISLAND_VOLUME_STEPS.reduce((best, step) =>
    Math.abs(step.value - volume) < Math.abs(best.value - volume) ? step : best,
  ).value
}

interface IslandDesktopBridge {
  isDesktop?: boolean
  getAppConfig: () => Promise<{ island?: IslandConfig } | null>
  setIslandConfig: (
    patch: Partial<IslandConfig>,
  ) => Promise<{ ok: boolean; error?: string; config: IslandConfig }>
  onIslandConfigChanged?: (callback: (config: IslandConfig) => void) => () => void
}

function getIslandBridge(): IslandDesktopBridge | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const desktop = (window as unknown as { shogoDesktop?: IslandDesktopBridge }).shogoDesktop
  return desktop?.isDesktop ? desktop : null
}

export function AppearanceTab() {
  const { theme, setTheme } = useTheme()
  const { settings: ap, update, reset } = useAppearance()
  const islandBridge = getIslandBridge()
  const [islandConfig, setIslandConfig] = useState<IslandConfig | null>(null)
  const [shortcut, setShortcut] = useState('')
  const [islandError, setIslandError] = useState('')
  const { Sun, Moon, Monitor, RotateCcw } = useAccountSheetIcons({
    Sun: SunIcon,
    Moon: MoonIcon,
    Monitor: MonitorIcon,
    RotateCcw: RotateCcwIcon,
  })
  const themeIconByValue = { light: Sun, dark: Moon, system: Monitor } as const

  const applyIslandConfig = (config: IslandConfig) => {
    setIslandConfig(config)
    setShortcut(config.shortcut)
  }

  useEffect(() => {
    if (!islandBridge) return
    void islandBridge.getAppConfig().then((config) => {
      if (config?.island) applyIslandConfig(config.island)
    })
    return islandBridge.onIslandConfigChanged?.(applyIslandConfig)
  }, [islandBridge])

  const updateIsland = async (patch: Partial<IslandConfig>) => {
    if (!islandBridge || !islandConfig) return
    setIslandConfig({ ...islandConfig, ...patch })
    const result = await islandBridge.setIslandConfig(patch)
    applyIslandConfig(result.config)
    setIslandError(result.ok ? '' : result.error ?? 'Could not save island settings')
  }

  const commitShortcut = () => {
    if (islandConfig && shortcut.trim() !== islandConfig.shortcut) {
      void updateIsland({ shortcut })
    }
  }

  return (
    <View>
      <Text className="text-2xl font-bold text-foreground mb-1">Appearance</Text>
      <Text className="text-sm text-muted-foreground mb-6">
        Customize the look and feel of the Shogo interface.
      </Text>

      {/* ── Theme ── */}
      <AppearanceSection title="Theme" />
      <View className="flex-row gap-2 mb-2">
        {THEME_CHOICES.map(({ value, label }) => {
          const Icon = themeIconByValue[value]
          return (
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
          )
        })}
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

      {islandBridge && islandConfig ? (
        <>
          <AppearanceSection title="Desktop Island" />
          <AppearanceRow
            label="Show Shogo Island"
            description="Keep agent activity and approvals visible above other apps"
          >
            <Switch
              value={islandConfig.enabled}
              onValueChange={(enabled) => void updateIsland({ enabled })}
            />
          </AppearanceRow>
          <AppearanceRow
            label="Auto-hide when idle"
            description="Show the island when a session is running or needs attention"
          >
            <Switch
              value={islandConfig.autoHide}
              onValueChange={(autoHide) => void updateIsland({ autoHide })}
            />
          </AppearanceRow>
          <AppearanceRow
            label="Quick chat shortcut"
            description="Use a platform shortcut such as CommandOrControl+Shift+Space"
          >
            <TextInput
              value={shortcut}
              onChangeText={setShortcut}
              onBlur={commitShortcut}
              onSubmitEditing={commitShortcut}
              className="min-w-[180px] rounded border border-border px-2 py-1 text-xs text-foreground"
              placeholder="CommandOrControl+Shift+Space"
              placeholderTextColor="#888"
            />
          </AppearanceRow>
          <AppearanceRow
            label="Island sounds"
            description="Chime when an agent needs you or finishes, unless you're already looking at that chat"
          >
            <Switch
              value={islandConfig.sounds}
              onValueChange={(sounds) => void updateIsland({ sounds })}
            />
          </AppearanceRow>
          {islandConfig.sounds ? (
            <AppearanceRow label="Sound volume">
              <View className="flex-row gap-1">
                {ISLAND_VOLUME_STEPS.map((step) => {
                  const selected = nearestVolumeStep(islandConfig.soundVolume) === step.value
                  return (
                    <Pressable
                      key={step.label}
                      onPress={() => {
                        playIslandSound('needs-you', step.value)
                        void updateIsland({ soundVolume: step.value })
                      }}
                      className={cn(
                        'px-2.5 py-1 rounded border',
                        selected ? 'border-primary bg-primary/10' : 'border-border',
                      )}
                    >
                      <Text
                        className={cn(
                          'text-xs font-medium',
                          selected ? 'text-primary' : 'text-muted-foreground',
                        )}
                      >
                        {step.label}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </AppearanceRow>
          ) : null}
          {islandError ? (
            <Text className="text-xs text-destructive mb-2 px-1">{islandError}</Text>
          ) : null}
        </>
      ) : null}

      <Pressable
        onPress={reset}
        className="mt-4 py-2.5 rounded-lg border border-border items-center active:bg-muted"
      >
        <Text className="text-sm text-muted-foreground">Reset to defaults</Text>
      </Pressable>
    </View>
  )
}

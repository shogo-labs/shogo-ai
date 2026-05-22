// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SettingsPanel - Consolidated settings view with a grouped left sidebar.
 *
 * Replaces the old per-tab Folders / Capabilities / Channels / Agents /
 * Monitor / Checkpoints panels. The Settings tab in the project top bar
 * mounts a single SettingsPanel; the caller passes a `groups` prop
 * describing the macOS-System-Settings-style sidebar (group headers + leaf
 * items, each with an icon and a `render` callback for the right pane).
 *
 * Internal sub-tabs from the old panels (Monitor → Overview/Analytics/Logs,
 * Capabilities → Configuration/Skills/Integrations) are flattened into
 * top-level sidebar entries by the caller, so each is reachable in a single
 * click.
 *
 * The active section persists to AsyncStorage so reopening Settings returns
 * the user to the last-visited page. On narrow screens (< 768px wide) the
 * sidebar collapses to a horizontal scroller pinned to the top.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, useWindowDimensions } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cn } from '@shogo/shared-ui/primitives'

export interface SettingsSectionItem {
  id: string
  label: string
  icon: React.ElementType
  /** Rendered into the right pane while this item is the active selection. */
  render: () => React.ReactNode
}

export interface SettingsSectionGroup {
  id: string
  /** Uppercase header text rendered above the group's items. */
  label: string
  items: SettingsSectionItem[]
}

/**
 * Imperative request to jump to a specific section. The nonce dedups
 * identical requests (e.g. two consecutive subagent streams both targeting
 * the Agents pane) so the panel honours the request both times even if
 * `id` doesn't change.
 */
export interface SettingsRequest {
  id: string
  nonce: number
}

interface SettingsPanelProps {
  visible: boolean
  groups: SettingsSectionGroup[]
  /**
   * When this prop transitions to a new nonce (or first becomes non-null),
   * the panel jumps to `id`. Used by the project layout to focus the
   * Agents pane when a subagent stream starts, etc.
   */
  requestedItem?: SettingsRequest | null
}

const ACTIVE_SECTION_STORAGE_KEY = 'shogo:settingsPanel:section'
const NARROW_BREAKPOINT = 768
const SIDEBAR_WIDTH = 220

export function SettingsPanel({ visible, groups, requestedItem }: SettingsPanelProps) {
  const { width } = useWindowDimensions()
  const isNarrow = width < NARROW_BREAKPOINT

  const flatItems = useMemo(
    () => groups.flatMap((g) => g.items),
    [groups],
  )
  const firstItemId = flatItems[0]?.id ?? null

  const [activeId, setActiveId] = useState<string | null>(firstItemId)
  const [hydrated, setHydrated] = useState(false)

  // Hydrate the last-visited section from AsyncStorage once on mount.
  useEffect(() => {
    let alive = true
    AsyncStorage.getItem(ACTIVE_SECTION_STORAGE_KEY)
      .then((stored) => {
        if (!alive) return
        if (stored && flatItems.some((it) => it.id === stored)) {
          setActiveId(stored)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
    // Run once — the stored id is only consulted on first mount; subsequent
    // group changes don't trigger a re-hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If the active item disappears from the groups (e.g. a platform-gated
  // section), fall back to the first available item.
  useEffect(() => {
    if (!hydrated) return
    if (activeId && flatItems.some((it) => it.id === activeId)) return
    if (firstItemId) setActiveId(firstItemId)
  }, [activeId, flatItems, firstItemId, hydrated])

  // Honour external "jump to section" requests. We watch the whole request
  // object (id + nonce) so back-to-back requests for the same section still
  // trigger a switch.
  useEffect(() => {
    if (!requestedItem) return
    if (!flatItems.some((it) => it.id === requestedItem.id)) return
    setActiveId(requestedItem.id)
    AsyncStorage.setItem(ACTIVE_SECTION_STORAGE_KEY, requestedItem.id).catch(() => {})
  }, [requestedItem, flatItems])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
    AsyncStorage.setItem(ACTIVE_SECTION_STORAGE_KEY, id).catch(() => {})
  }, [])

  const activeItem = useMemo(
    () => flatItems.find((it) => it.id === activeId) ?? null,
    [flatItems, activeId],
  )

  if (!visible) return null

  return (
    <View
      className="absolute inset-0 bg-background"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <View className={cn('flex-1', isNarrow ? 'flex-col' : 'flex-row')}>
        {isNarrow ? (
          <NarrowSidebar
            groups={groups}
            activeId={activeId}
            onSelect={handleSelect}
          />
        ) : (
          <WideSidebar
            groups={groups}
            activeId={activeId}
            onSelect={handleSelect}
          />
        )}

        <View className="flex-1 min-h-0 relative">
          {activeItem ? (
            <View className="absolute inset-0">{activeItem.render()}</View>
          ) : (
            <View className="flex-1 items-center justify-center px-6">
              <Text className="text-sm text-muted-foreground">
                No settings sections available.
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}

function WideSidebar({
  groups,
  activeId,
  onSelect,
}: {
  groups: SettingsSectionGroup[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <View
      className="bg-muted/40 dark:bg-black/20 border-r border-border"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
        {groups.map((group) => (
          <View key={group.id} className="mb-2">
            <Text className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </Text>
            {group.items.map((item) => {
              const Icon = item.icon
              const isActive = item.id === activeId
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onSelect(item.id)}
                  className={cn(
                    'mx-1.5 my-0.5 px-2 py-1.5 rounded-md flex-row items-center gap-2',
                    isActive ? 'bg-accent' : 'active:bg-muted',
                  )}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                >
                  <Icon
                    size={14}
                    className={cn(
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <Text
                    className={cn(
                      'text-[13px]',
                      isActive
                        ? 'text-foreground font-medium'
                        : 'text-foreground',
                    )}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

function NarrowSidebar({
  groups,
  activeId,
  onSelect,
}: {
  groups: SettingsSectionGroup[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <View className="border-b border-border bg-muted/40 dark:bg-black/20">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 6, gap: 4 }}
      >
        {groups.flatMap((group, gi) =>
          group.items.map((item, ii) => {
            const Icon = item.icon
            const isActive = item.id === activeId
            const showDivider = ii === 0 && gi > 0
            return (
              <React.Fragment key={item.id}>
                {showDivider && (
                  <View className="self-center w-px h-5 bg-border mx-1" />
                )}
                <Pressable
                  onPress={() => onSelect(item.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-md flex-row items-center gap-1.5',
                    isActive ? 'bg-accent' : 'active:bg-muted',
                  )}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={item.label}
                >
                  <Icon
                    size={12}
                    className={cn(
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <Text
                    className={cn(
                      'text-xs',
                      isActive
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground',
                    )}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              </React.Fragment>
            )
          }),
        )}
      </ScrollView>
    </View>
  )
}

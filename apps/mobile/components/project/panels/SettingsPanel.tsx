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
 * the user to the last-visited page. On narrow web/tablet screens (< 768px)
 * the sidebar collapses to a horizontal scroller. On native phones it becomes
 * a single picker row that opens a grouped section sheet — wrapping chips
 * overflow and steal too much vertical space on a handset.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  useWindowDimensions,
  Platform,
  Modal,
  StyleSheet,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, ChevronDown, X } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cn } from '@shogo/shared-ui/primitives'
import { isNativePhoneIntegrationsLayout, nativeSettingsPaneStyle, NATIVE_PHONE_PICKER_INSET } from '../../../lib/native-phone-layout'

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
  const { width, height } = useWindowDimensions()
  const isNarrow = width < NARROW_BREAKPOINT
  const isNativePhone = isNativePhoneIntegrationsLayout(width, height)

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

  if (isNativePhone) {
    return (
      <View
        collapsable={false}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width,
          maxWidth: width,
          overflow: 'hidden',
        }}
      >
        <NativePhoneSidebar
          groups={groups}
          activeId={activeId}
          onSelect={handleSelect}
          screenWidth={width}
          windowHeight={height}
        />
        <View collapsable={false} style={{ ...nativeSettingsPaneStyle(width), overflow: 'hidden' }}>
          {activeItem ? activeItem.render() : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
              <Text className="text-sm text-muted-foreground">
                No settings sections available.
              </Text>
            </View>
          )}
        </View>
      </View>
    )
  }

  return (
      <View
        className="absolute inset-0 bg-background"
        style={{ display: visible ? 'flex' : 'none' }}
      >
      <View
        style={{
          flex: 1,
          flexDirection: isNarrow ? 'column' : 'row',
          width: '100%',
          alignSelf: 'stretch',
        }}
      >
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

        <View className="flex-1 min-h-0 min-w-0 relative" style={{ width: '100%' }}>
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
                  testID={`settings-nav-${item.id}`}
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

function NativePhoneSidebar({
  groups,
  activeId,
  onSelect,
  screenWidth,
  windowHeight,
}: {
  groups: SettingsSectionGroup[]
  activeId: string | null
  onSelect: (id: string) => void
  screenWidth: number
  windowHeight: number
}) {
  const [open, setOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const activeItem =
    groups.flatMap((group) => group.items).find((item) => item.id === activeId) ?? null
  const ActiveIcon = activeItem?.icon
  const pickerWidth = Math.max(0, screenWidth - NATIVE_PHONE_PICKER_INSET)

  return (
    <>
      <View
        collapsable={false}
        style={{
          width: screenWidth,
          maxWidth: screenWidth,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: 'rgba(127,127,127,0.35)',
        }}
      >
        {/*
          Width lives on a plain View, not the Pressable. RN Text defaults to
          flexShrink: 1, so a content-sized row + numberOfLines={1} clips the
          section name down to the icon and chevron.
        */}
        <View
          collapsable={false}
          style={[pickerStyles.shell, { width: pickerWidth }]}
        >
          <Pressable
            onPress={() => setOpen(true)}
            testID="settings-section-picker"
            accessibilityRole="button"
            accessibilityLabel={`Settings section, ${activeItem?.label ?? 'Select'}. Opens the section list.`}
            style={[pickerStyles.pressable, { width: pickerWidth }]}
          >
            {ActiveIcon ? (
              <ActiveIcon size={18} className="text-foreground" />
            ) : null}
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className="text-foreground"
              style={pickerStyles.label}
            >
              {activeItem?.label ?? 'Settings'}
            </Text>
            <ChevronDown size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={sheetStyles.root}>
          <Pressable
            style={sheetStyles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityLabel="Dismiss"
            accessibilityRole="button"
          />
          <View
            className="w-full rounded-t-3xl border border-border border-b-0 bg-card"
            style={{
              maxHeight: Math.round(windowHeight * 0.78),
              paddingBottom: Math.max(insets.bottom, 16),
            }}
          >
            <View className="items-center pt-2 pb-1">
              <View className="h-1 w-11 rounded-full bg-muted-foreground/35" />
            </View>
            <View className="flex-row items-center px-4 pb-3">
              <Pressable
                onPress={() => setOpen(false)}
                hitSlop={8}
                accessibilityLabel="Close"
                accessibilityRole="button"
                className="h-10 w-10 items-center justify-center rounded-full bg-muted"
              >
                <X size={18} className="text-foreground" />
              </Pressable>
              <Text className="flex-1 px-3 text-center text-[17px] font-semibold text-foreground">
                Settings
              </Text>
              <View className="h-10 w-10" />
            </View>
            <ScrollView
              style={{ maxHeight: Math.round(windowHeight * 0.62) }}
              contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              {groups.map((group) => (
                <View key={group.id} className="mb-3">
                  <Text className="px-2 pt-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </Text>
                  <View className="overflow-hidden rounded-2xl bg-muted/50">
                    {group.items.map((item, index) => {
                      const Icon = item.icon
                      const isActive = item.id === activeId
                      return (
                        <Pressable
                          key={item.id}
                          testID={`settings-nav-${item.id}`}
                          onPress={() => {
                            onSelect(item.id)
                            setOpen(false)
                          }}
                          className={cn(
                            'min-h-12 flex-row items-center gap-3 px-3.5 py-2.5',
                            index > 0 && 'border-t border-border/60',
                            isActive && 'bg-muted',
                          )}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: isActive }}
                          accessibilityLabel={item.label}
                        >
                          <Icon
                            size={18}
                            className={cn(
                              isActive ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          />
                          <Text
                            className={cn(
                              'flex-1 text-[16px]',
                              isActive
                                ? 'font-semibold text-foreground'
                                : 'text-foreground',
                            )}
                            numberOfLines={1}
                          >
                            {item.label}
                          </Text>
                          {isActive ? (
                            <Check size={18} className="text-foreground" />
                          ) : null}
                        </Pressable>
                      )
                    })}
                  </View>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
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
  const isNative = Platform.OS !== 'web'

  return (
    <View className="border-b border-border bg-muted/40 dark:bg-black/20">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: isNative ? 10 : 8,
          paddingVertical: isNative ? 8 : 6,
          gap: isNative ? 6 : 4,
        }}
      >
        {groups.flatMap((group, gi) =>
          group.items.map((item, ii) => {
            const Icon = item.icon
            const isActive = item.id === activeId
            const showDivider = ii === 0 && gi > 0
            return (
              <React.Fragment key={item.id}>
                {showDivider && (
                  <View className={cn('self-center w-px bg-border mx-1', isNative ? 'h-6' : 'h-5')} />
                )}
                <Pressable
                  onPress={() => onSelect(item.id)}
                  testID={`settings-nav-${item.id}`}
                  className={cn(
                    'rounded-md flex-row items-center gap-1.5',
                    isNative ? 'min-h-10 px-3 py-2' : 'px-2.5 py-1',
                    isActive ? 'bg-accent' : 'active:bg-muted',
                  )}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  accessibilityLabel={item.label}
                >
                  <Icon
                    size={isNative ? 17 : 12}
                    className={cn(
                      isActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <Text
                    className={cn(
                      isNative ? 'text-sm' : 'text-xs',
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

const pickerStyles = StyleSheet.create({
  shell: {
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(120,120,128,0.24)',
    overflow: 'hidden',
  },
  pressable: {
    height: 48,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    marginLeft: 12,
    marginRight: 8,
    flexGrow: 1,
    flexShrink: 0,
    minWidth: 72,
    fontSize: 16,
    fontWeight: '600',
  },
})

const sheetStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
})

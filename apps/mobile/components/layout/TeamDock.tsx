// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The team workspace phone dock: Home, DMs, Activity and More in the floating
 * pill and a separate search button beside it. The floating "+" is drawn by
 * the tab screens themselves (`TabScreen`): a button outside the dock's own
 * bounds would not receive touches on native.
 */
import { useMemo } from 'react'
import { Pressable, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { Bell, Home, MessagesSquare, MoreHorizontal, Search } from 'lucide-react-native'
import { useResolvedTheme } from '../../contexts/theme'
import { useAgentActivity } from '../../hooks/useAgentActivity'
import { activityBadge } from '../../lib/activity-feed'
import { NATIVE_PHONE_COMPOSER_PILL_HEIGHT, NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET } from '../../lib/native-phone-layout'
import { dockTabForPathname } from '../../lib/sidebar-tab'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'
import { GlassTabRow } from './GlassTabRow'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'

const ITEMS = [
  // `/` lands on the workspace agent; Home in the dock keeps the feed.
  { id: 'home', label: 'Home', Icon: Home, href: '/(app)/home' },
  { id: 'dms', label: 'DMs', Icon: MessagesSquare, href: '/(app)/c/dms' },
  { id: 'activity', label: 'Activity', Icon: Bell, href: '/(app)/activity' },
  { id: 'more', label: 'More', Icon: MoreHorizontal, href: '/(app)/more' },
] as const

const SIZE = NATIVE_PHONE_COMPOSER_PILL_HEIGHT

export function TeamDock({ maxWidth }: { maxWidth: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const isDark = useResolvedTheme() === 'dark'
  const chat = useTeamChatNav()
  const agents = useAgentActivity({ light: true })
  const active = dockTabForPathname(pathname, chat.list)
  const dms = chat.counts.dms
  const activity = activityBadge(chat.counts.inbox, agents.tasks)
  // Thread replies the user chose to keep out of the number show as a dot.
  const activityDot = !!chat.counts.activityDot
  const tint = isDark ? 'rgba(28,28,30,0.2)' : 'rgba(255,255,255,0.1)'

  // The same glass pill as the personal tab bar (one drag-able selection
  // capsule, serialised navigation), plus a round search button beside it.
  // Built from the badge values alone, so an unrelated chat event that leaves
  // them where they were hands `GlassTabRow` the same array and it bails
  // (SHO-600).
  const items = useMemo(
    () =>
      ITEMS.map(({ id, label, Icon, href }) => ({
        id,
        label,
        Icon,
        badge: id === 'dms' ? dms : id === 'activity' ? activity : 0,
        dot: id === 'activity' && activityDot,
        onPress: () => router.replace(href as any),
      })),
    [activity, activityDot, dms, router],
  )

  return (
    <View className="w-full flex-row items-center gap-2" style={{ maxWidth, alignSelf: 'center' }} testID="team-dock">
      <View style={{ flex: 1 }} role="tablist" accessibilityLabel="Workspace tabs">
        <GlassTabRow
          items={items}
          active={active}
          height={SIZE}
          itemInset={NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET}
          isDark={isDark}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        onPress={() => router.push('/(app)/search' as any)}
        className="items-center justify-center bg-transparent shadow-sm"
        style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2 }}
      >
        <LiquidGlassBackdrop glassStyle="regular" tintColor={tint} style={{ borderRadius: SIZE / 2 }} />
        <View>
          <Search size={20} color={isDark ? '#a1a1aa' : '#6b7280'} />
        </View>
      </Pressable>
    </View>
  )
}

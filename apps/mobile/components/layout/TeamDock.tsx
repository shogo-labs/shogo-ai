// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The team workspace phone dock: Home, DMs, Activity and More in the floating
 * pill and a separate search button beside it. The floating "+" is drawn by
 * the tab screens themselves (`TabScreen`): a button outside the dock's own
 * bounds would not receive touches on native.
 */
import { Pressable, Text, View } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { Bell, Home, MessagesSquare, MoreHorizontal, Search } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useResolvedTheme } from '../../contexts/theme'
import { useAgentActivity } from '../../hooks/useAgentActivity'
import { activityBadge } from '../../lib/activity-feed'
import { NATIVE_PHONE_COMPOSER_PILL_HEIGHT, NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET, NATIVE_PHONE_GUTTER } from '../../lib/native-phone-layout'
import { dockTabForPathname } from '../../lib/sidebar-tab'
import { LiquidGlassBackdrop, supportsLiquidGlass } from '../ui/LiquidGlassBackdrop'
import { badgeText } from './sidebar/IconRail'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'

const ITEMS = [
  { id: 'home', label: 'Home', icon: Home, href: '/(app)' },
  { id: 'dms', label: 'DMs', icon: MessagesSquare, href: '/(app)/c/dms' },
  { id: 'activity', label: 'Activity', icon: Bell, href: '/(app)/activity' },
  { id: 'more', label: 'More', icon: MoreHorizontal, href: '/(app)/more' },
] as const

const SIZE = NATIVE_PHONE_COMPOSER_PILL_HEIGHT

export function TeamDock({ maxWidth }: { maxWidth: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const isDark = useResolvedTheme() === 'dark'
  const liquidGlass = supportsLiquidGlass()
  const chat = useTeamChatNav()
  const agents = useAgentActivity({ light: true })
  const active = dockTabForPathname(pathname, chat.list)
  const badges: Record<string, number> = {
    dms: chat.counts.dms,
    activity: activityBadge(chat.counts.inbox, agents.tasks),
  }
  const surface = cn('shadow-sm overflow-hidden', liquidGlass ? 'bg-transparent' : 'bg-card/95')
  const tint = isDark ? 'rgba(28,28,30,0.42)' : 'rgba(255,255,255,0.42)'

  return (
    <View className="w-full flex-row items-center gap-2" style={{ maxWidth, alignSelf: 'center' }} testID="team-dock">
      <View role="tablist" accessibilityLabel="Workspace tabs" className={cn('flex-1 flex-row items-center gap-1 px-1.5', surface)} style={{ height: SIZE, borderRadius: SIZE / 2 }}>
        <LiquidGlassBackdrop tintColor={tint} style={{ borderRadius: SIZE / 2 }} />
        {ITEMS.map(({ id, label, icon: Icon, href }) => {
          const selected = active === id
          const count = badges[id] ?? 0
          return (
            <Pressable
              key={id}
              onPress={() => router.replace(href as any)}
              accessibilityRole="tab"
              aria-selected={selected}
              accessibilityLabel={count ? `${label}, ${count} unread` : label}
              className={cn('flex-1 items-center justify-center rounded-full', selected && 'bg-primary/10')}
              style={{ height: SIZE - NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET * 2 }}
            >
              <Icon size={23} color={selected ? (isDark ? '#F09050' : '#E27927') : isDark ? '#a1a1aa' : '#6b7280'} strokeWidth={selected ? 2.2 : 1.9} />
              {count > 0 && (
                <View testID="dock-badge" className="absolute right-3 top-0.5 min-w-[16px] items-center rounded-full bg-destructive px-1">
                  <Text className="text-[10px] font-semibold leading-4 text-white">{badgeText(count)}</Text>
                </View>
              )}
            </Pressable>
          )
        })}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search"
        onPress={() => router.push('/(app)/search' as any)}
        className={cn('items-center justify-center', surface)}
        style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2 }}
      >
        <LiquidGlassBackdrop tintColor={tint} style={{ borderRadius: SIZE / 2 }} />
        <Search size={20} color={isDark ? '#a1a1aa' : '#6b7280'} />
      </Pressable>

    </View>
  )
}

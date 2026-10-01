// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop icon rail: one button per tab, each with its label under it
 * and a badge when something needs you. The selected tab drives the list
 * panel beside it; tapping it again hides or shows that panel.
 */
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Bot, Folder, Hash, Home, MessagesSquare, Mic, MoreHorizontal, Plus, Settings, Target } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { SidebarTabId } from '@shogo/shared-app'
import { ShogoLogoMark } from '../../branding/ShogoLogoMark'
import { CreateMenu } from '../CreateMenu'
import { ProfileMenu } from '../ProfileMenu'

export const TAB_META: Record<SidebarTabId, { label: string; icon: React.ElementType }> = {
  home: { label: 'Home', icon: Home },
  channels: { label: 'Channels', icon: Hash },
  dms: { label: 'DMs', icon: MessagesSquare },
  agents: { label: 'Agents', icon: Bot },
  projects: { label: 'Projects', icon: Folder },
  meetings: { label: 'Meetings', icon: Mic },
  goals: { label: 'Goals', icon: Target },
  activity: { label: 'Activity', icon: Bell },
  more: { label: 'More', icon: MoreHorizontal },
}

export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <View testID="rail-badge" className="absolute -right-1 -top-1 min-w-[16px] items-center rounded-full bg-destructive px-1">
      <Text className="text-[10px] font-semibold leading-4 text-white">{badgeText(count)}</Text>
    </View>
  )
}

export interface IconRailProps {
  tabs: SidebarTabId[]
  active: SidebarTabId
  badges: Partial<Record<SidebarTabId, number>>
  onSelect: (tab: SidebarTabId) => void
  showAdmin?: boolean
}

export function IconRail({ tabs, active, badges, onSelect, showAdmin }: IconRailProps) {
  const router = useRouter()
  return (
    <View role="navigation" accessibilityLabel="Workspace tabs" className="w-[72px] shrink-0 items-center border-r border-border bg-muted/50 pb-3 pt-3">
      <Pressable accessibilityRole="link" accessibilityLabel="Shogo home" onPress={() => router.push('/(app)' as any)} className="mb-4 h-10 w-10 items-center justify-center rounded-xl active:bg-muted">
        <ShogoLogoMark className="h-6 w-6" />
      </Pressable>

      <View className="items-center gap-1">
        {tabs.map((id) => {
          const { label, icon: Icon } = TAB_META[id]
          const selected = id === active
          const count = badges[id] ?? 0
          return (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityLabel={count ? `${label}, ${count} unread` : label}
              accessibilityState={{ selected }}
              onPress={() => onSelect(id)}
              className="w-16 items-center gap-0.5 py-1"
            >
              <View className={cn('h-9 w-11 items-center justify-center rounded-xl', selected ? 'bg-accent' : 'web:hover:bg-accent/60')}>
                <Icon size={19} className={selected ? 'text-foreground' : 'text-muted-foreground'} />
                <Badge count={count} />
              </View>
              <Text className={cn('text-[10px]', selected ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{label}</Text>
            </Pressable>
          )
        })}
      </View>

      <View className="mt-auto items-center gap-3">
        {showAdmin && (
          <Pressable accessibilityRole="link" accessibilityLabel="Admin" onPress={() => router.push('/(admin)' as any)} className="h-9 w-9 items-center justify-center rounded-xl active:bg-accent">
            <Settings size={18} className="text-muted-foreground" />
          </Pressable>
        )}
        <CreateMenu placement="right bottom">
          {({ open, ...props }) => (
            <Pressable {...props} accessibilityRole="button" accessibilityLabel="Create" accessibilityState={{ expanded: open }} className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80">
              <Plus size={18} className="text-primary-foreground" />
            </Pressable>
          )}
        </CreateMenu>
        <ProfileMenu placement="right bottom" />
      </View>
    </View>
  )
}

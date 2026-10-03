// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop icon rail: one button per tab, each with its label under it
 * and a badge when something needs you. The selected tab drives the list
 * panel beside it; tapping it again hides or shows that panel.
 */
import { createElement, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Bell, Bot, Folder, Hash, Home, Mail, MessagesSquare, Mic, MoreHorizontal, Plus, Search, Shield, Target } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ReactNode } from 'react'
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

/**
 * The rail shows icons only. The name appears in a bubble beside the icon on
 * hover or keyboard focus (web only: the rail is a wide-web layout).
 */
export function RailTooltip({ label, children }: { label: string; children: ReactNode }) {
  // Hover and keyboard focus are tracked apart: a click focuses the icon, and
  // losing that focus must not hide the label while the pointer is still on it.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  if (Platform.OS !== 'web') return <>{children}</>
  const shown = hovered || focused
  return createElement(
    'div',
    {
      onMouseEnter: () => setHovered(true),
      // A re-render under a still pointer can swallow the enter; any movement over the icon restores it.
      onMouseMove: () => !hovered && setHovered(true),
      onMouseLeave: () => setHovered(false),
      // Only keyboard focus: a mouse click should not leave a label stuck open.
      onFocus: (e: { target: { matches?: (selector: string) => boolean } }) => setFocused(!!e.target.matches?.(':focus-visible')),
      onBlur: () => setFocused(false),
      style: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' },
    },
    children,
    shown
      ? createElement(
          'div',
          {
            role: 'tooltip',
            'data-testid': 'rail-tooltip',
            style: { position: 'absolute', left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 10, zIndex: 100, pointerEvents: 'none', whiteSpace: 'nowrap', width: 'max-content' },
          },
          // A dark bubble with light text in both themes (the theme's own
          // foreground/background swap in dark mode, which would invert it).
          <View className="rounded-md border border-transparent bg-zinc-900 px-2.5 py-1.5 shadow-lg dark:border-white/20 dark:bg-zinc-600">
            <Text className="text-xs font-medium text-white">{label}</Text>
          </View>,
        )
      : null,
  )
}

export interface IconRailProps {
  tabs: SidebarTabId[]
  active: SidebarTabId
  badges: Partial<Record<SidebarTabId, number>>
  onSelect: (tab: SidebarTabId) => void
  showAdmin?: boolean
  /** The workspace tile that opens the workspace menu. Falls back to the logo. */
  switcher?: ReactNode
  /** Shown only while workspace invitations are waiting. */
  invites?: { count: number; onPress: () => void }
  /** A search button, for workspaces whose rail has no list panel with its own. */
  onSearch?: () => void
}

export function IconRail({ tabs, active, badges, onSelect, showAdmin, switcher, invites, onSearch }: IconRailProps) {
  const router = useRouter()
  return (
    <View role="navigation" accessibilityLabel="Workspace tabs" className="relative z-20 w-14 shrink-0 items-center border-r border-border bg-muted/50 pb-3 pt-3">
      {switcher ? (
        <View className="mb-3 h-10 items-center justify-center">
          <RailTooltip label="Workspaces and account">{switcher}</RailTooltip>
        </View>
      ) : (
        <View className="mb-3">
          <RailTooltip label="Shogo home">
            <Pressable accessibilityRole="link" accessibilityLabel="Shogo home" onPress={() => router.push('/(app)' as any)} className="h-10 w-10 items-center justify-center rounded-xl active:bg-muted">
              <ShogoLogoMark className="h-6 w-6" />
            </Pressable>
          </RailTooltip>
        </View>
      )}

      <View className="items-center gap-1.5">
        {tabs.map((id) => {
          const { label, icon: Icon } = TAB_META[id]
          const selected = id === active
          const count = badges[id] ?? 0
          return (
            <RailTooltip key={id} label={label}>
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={count ? `${label}, ${count} unread` : label}
                aria-selected={selected}
                onPress={() => onSelect(id)}
                className={cn('h-10 w-10 items-center justify-center rounded-xl', selected ? 'bg-accent' : 'web:hover:bg-accent/60')}
              >
                <Icon size={20} className={selected ? 'text-foreground' : 'text-muted-foreground'} />
                <Badge count={count} />
              </Pressable>
            </RailTooltip>
          )
        })}
      </View>

      <View className="mt-auto items-center gap-3">
        {invites && invites.count > 0 && (
          <RailTooltip label="Workspace invitations">
            <Pressable accessibilityRole="button" accessibilityLabel={`Workspace invitations, ${invites.count} waiting`} onPress={invites.onPress} className="h-9 w-9 items-center justify-center rounded-xl active:bg-accent">
              <Mail size={18} className="text-muted-foreground" />
              <Badge count={invites.count} />
            </Pressable>
          </RailTooltip>
        )}
        {onSearch && (
          <RailTooltip label="Search">
            <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={onSearch} className="h-9 w-9 items-center justify-center rounded-xl active:bg-accent">
              <Search size={18} className="text-muted-foreground" />
            </Pressable>
          </RailTooltip>
        )}
        {showAdmin && (
          <RailTooltip label="Admin">
            <Pressable accessibilityRole="link" accessibilityLabel="Admin" onPress={() => router.push('/(admin)' as any)} className="h-9 w-9 items-center justify-center rounded-xl active:bg-accent">
              <Shield size={18} className="text-muted-foreground" />
            </Pressable>
          </RailTooltip>
        )}
        <RailTooltip label="Create">
          <CreateMenu placement="right bottom">
            {({ open, ...props }) => (
              <Pressable {...props} accessibilityRole="button" accessibilityLabel="Create" aria-expanded={open} className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80">
                <Plus size={18} className="text-primary-foreground" />
              </Pressable>
            )}
          </CreateMenu>
        </RailTooltip>
        <RailTooltip label="Profile and settings">
          <ProfileMenu placement="right bottom" />
        </RailTooltip>
      </View>
    </View>
  )
}

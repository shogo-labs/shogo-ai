// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The menu behind your avatar: who you are, your status, pausing
 * notifications, and the way into settings and your account. The same menu
 * opens from the avatar on every mobile tab and from the bottom of the
 * desktop rail.
 */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { BellOff, ChevronDown, ChevronRight, Settings, SmilePlus, UserRound } from 'lucide-react-native'
import { Avatar, cn } from '@shogo/shared-ui/primitives'
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover'
import { useAuth } from '../../contexts/auth'
import { useChatSettings } from '../../hooks/useChatPrefs'
import { usePresence } from '../../hooks/usePresence'
import { PAUSE_OPTIONS, pauseState } from '../../lib/profile-menu'
import { expiryFrom } from '../../lib/team-chat-state'
import { PresenceDot, presenceLabel } from '../team-chat/PresenceDot'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'

function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export interface ProfileMenuProps {
  placement?: 'bottom right' | 'bottom left' | 'right bottom' | 'top left'
  size?: 'sm' | 'md'
  /** Open the menu on every avatar tap; false only for tests. */
  testID?: string
}

/** The avatar button and the menu it opens. */
export function ProfileMenu({ placement = 'bottom right', size = 'md', testID = 'profile-avatar' }: ProfileMenuProps) {
  const { user } = useAuth()
  const chat = useTeamChatNav()
  const [open, setOpen] = useState(false)
  const status = usePresence(chat.workspaceId, user?.id)
  const dimension = size === 'sm' ? 32 : 40
  return (
    <Popover
      placement={placement}
      size="sm"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel="Profile and settings"
          accessibilityState={{ expanded: open }}
          className="active:opacity-80"
          style={{ width: dimension, height: dimension }}
        >
          <Avatar fallback={initials(user?.name)} src={user?.image} size={size === 'sm' ? 'sm' : 'md'} />
          {chat.enabled && status ? <PresenceDot userId={user?.id} workspaceId={chat.workspaceId} badge size={10} /> : null}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0">
        <PopoverBody>
          <ProfileMenuContent onClose={() => setOpen(false)} />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

const ROW = 'flex-row items-center gap-3 px-3 py-2.5 active:bg-muted'

/** Mounted only while the menu is open, so settings load on demand. */
export function ProfileMenuContent({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const { user } = useAuth()
  const chat = useTeamChatNav()
  const presence = usePresence(chat.workspaceId, user?.id)
  const { settings, update } = useChatSettings(chat.enabled ? chat.workspaceId : null)
  const [pauseOpen, setPauseOpen] = useState(false)
  const pause = pauseState(settings?.dndUntil)
  const go = (href: string) => {
    onClose()
    router.push(href as any)
  }

  return (
    <View role="menu" className="py-1" testID="profile-menu">
      <View className="flex-row items-center gap-3 px-3 py-3">
        <Avatar fallback={initials(user?.name)} src={user?.image} size="md" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>{user?.name || 'You'}</Text>
          {chat.enabled ? (
            <View className="flex-row items-center gap-1.5">
              <PresenceDot userId={user?.id} workspaceId={chat.workspaceId} />
              <Text className="text-xs text-muted-foreground">{presenceLabel(presence)}</Text>
            </View>
          ) : user?.email ? (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{user.email}</Text>
          ) : null}
        </View>
      </View>

      <View className="my-1 h-px bg-border" />

      {chat.enabled && (
        <>
          <Pressable role="menuitem" accessibilityLabel="What's your status?" onPress={() => go('/(app)/c/settings')} className={ROW}>
            <SmilePlus size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {settings?.statusEmoji || settings?.statusText ? `${settings.statusEmoji ?? ''} ${settings.statusText ?? ''}`.trim() : "What's your status?"}
            </Text>
            <ChevronRight size={14} className="text-muted-foreground" />
          </Pressable>

          <Pressable
            role="menuitem"
            accessibilityLabel={pause.paused ? 'Notifications paused' : 'Pause notifications'}
            accessibilityState={{ expanded: pauseOpen }}
            onPress={() => setPauseOpen((v) => !v)}
            className={ROW}
          >
            <BellOff size={16} className={pause.paused ? 'text-primary' : 'text-muted-foreground'} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground">{pause.paused ? 'Notifications paused' : 'Pause notifications'}</Text>
              {pause.paused ? <Text className="text-xs text-muted-foreground">{pause.until}</Text> : null}
            </View>
            {pauseOpen ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
          </Pressable>
          {pauseOpen && (
            <View className="pb-1 pl-9">
              {pause.paused && (
                <Pressable
                  role="menuitem"
                  accessibilityLabel="Resume notifications"
                  onPress={() => {
                    void update({ dndUntil: null })
                    setPauseOpen(false)
                  }}
                  className="px-3 py-2 active:bg-muted"
                >
                  <Text className="text-sm font-medium text-primary">Resume notifications</Text>
                </Pressable>
              )}
              {PAUSE_OPTIONS.map((option) => (
                <Pressable
                  key={option.label}
                  role="menuitem"
                  accessibilityLabel={`Pause for ${option.label}`}
                  onPress={() => {
                    void update({ dndUntil: expiryFrom(option.value) })
                    setPauseOpen(false)
                  }}
                  className={cn('px-3 py-2 active:bg-muted')}
                >
                  <Text className="text-sm text-foreground">{option.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View className="my-1 h-px bg-border" />
        </>
      )}

      <Pressable role="menuitem" accessibilityLabel="Preferences" onPress={() => go('/(app)/settings')} className={ROW}>
        <Settings size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">Preferences</Text>
      </Pressable>
      <Pressable role="menuitem" accessibilityLabel="Account and workspaces" onPress={() => go('/(app)/account')} className={ROW}>
        <UserRound size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">Account and workspaces</Text>
      </Pressable>
    </View>
  )
}

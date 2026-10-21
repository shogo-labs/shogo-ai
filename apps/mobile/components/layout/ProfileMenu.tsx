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
import { BellOff, ChevronDown, ChevronRight, LogOut, Monitor, Settings, Shield, SmilePlus, Store, User, UserRound } from 'lucide-react-native'
import { Avatar, cn } from '@shogo/shared-ui/primitives'
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover'
import { useAuth } from '../../contexts/auth'
import { useTheme, type ThemePreference } from '../../contexts/theme'
import { usePostHogSafe } from '../../contexts/posthog'
import { useChatSettings } from '../../hooks/useChatPrefs'
import { useHasAdminAccess } from '../../hooks/useHasAdminAccess'
import { usePresence } from '../../hooks/usePresence'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { PAUSE_OPTIONS, pauseState } from '../../lib/profile-menu'
import { usePlatformConfig } from '../../lib/platform-config'
import { expiryFrom } from '../../lib/team-chat-state'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { PresenceDot, presenceLabel } from '../team-chat/PresenceDot'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'
import { ThemeChoiceList } from './sidebar/ThemeChoiceList'

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
  /** Presence-dot ring. The rail passes the sidebar color so the dot sits on that surface. */
  badgeRingClassName?: string
}

/** The avatar button and the menu it opens. */
export function ProfileMenu({ placement = 'bottom right', size = 'md', testID = 'profile-avatar', badgeRingClassName }: ProfileMenuProps) {
  const router = useRouter()
  const { user, signOut } = useAuth()
  const chat = useTeamChatNav()
  const posthog = usePostHogSafe()
  const [open, setOpen] = useState(false)
  const status = usePresence(chat.workspaceId, user?.id)
  const { localMode, shogoKeyConnected } = usePlatformConfig()
  const isSuperAdmin = useHasAdminAccess(user?.id)
  const { theme, setTheme } = useTheme()
  // The menu renders in a portal above the app's providers, so everything that
  // comes from context is read here, where the avatar is, and passed down.
  const { settings, update } = useChatSettings(chat.enabled ? chat.workspaceId : null)
  const model: ProfileMenuModel = {
    user: user ? { id: user.id, name: user.name, email: user.email, image: user.image } : null,
    chatEnabled: chat.enabled,
    workspaceId: chat.workspaceId,
    presence: status,
    settings,
    update,
    isSuperAdmin,
    showCreator: !localMode || !!shogoKeyConnected,
    localMode,
    theme,
    setTheme,
    go: (href) => {
      setOpen(false)
      router.push(href as any)
    },
    signOut: () => {
      setOpen(false)
      trackEvent(posthog, EVENTS.SIGN_OUT)
      void signOut().catch(() => {})
    },
  }
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
          aria-expanded={open}
          className="relative items-center justify-center active:opacity-80"
          style={{ width: dimension, height: dimension }}
        >
          <Avatar fallback={initials(user?.name)} src={resolveAvatarUrl(user?.image)} size={size === 'sm' ? 'sm' : 'md'} />
          {chat.enabled && status ? (
            <PresenceDot
              userId={user?.id}
              workspaceId={chat.workspaceId}
              badge
              size={10}
              ringClassName={badgeRingClassName}
            />
          ) : null}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0">
        <PopoverBody>
          <ProfileMenuContent model={model} />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

const ROW = 'flex-row items-center gap-3 px-3 py-2.5 active:bg-muted'

export interface ProfileMenuModel {
  user: { id?: string; name?: string | null; email?: string | null; image?: string | null } | null
  chatEnabled: boolean
  workspaceId: string | null
  presence: ReturnType<typeof usePresence>
  settings: ReturnType<typeof useChatSettings>['settings']
  update: ReturnType<typeof useChatSettings>['update']
  /** Closes the menu and navigates. */
  go: (href: string) => void
  isSuperAdmin?: boolean
  /** Creator hub is cloud-backed, so desktop hides it until Shogo Cloud is signed in. */
  showCreator?: boolean
  localMode?: boolean
  theme?: ThemePreference
  setTheme?: (theme: ThemePreference) => void
  /** Closes the menu and signs out. Omitted where there is no session. */
  signOut?: () => void
}

/**
 * The menu body. Purely presentational: it renders in a portal, outside the
 * app's context providers, so it must not read any (auth, router, chat) itself.
 */
export function ProfileMenuContent({ model }: { model: ProfileMenuModel }) {
  const { user, presence, settings, update, go, signOut } = model
  const chat = { enabled: model.chatEnabled, workspaceId: model.workspaceId }
  const [pauseOpen, setPauseOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const pause = pauseState(settings?.dndUntil)

  return (
    <View role="menu" className="py-1" testID="profile-menu">
      <View className="flex-row items-center gap-3 px-3 py-3">
        <Avatar fallback={initials(user?.name)} src={resolveAvatarUrl(user?.image)} size="md" />
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
          <Pressable role="menuitem" accessibilityLabel="What's your status?" onPress={() => go('/(app)/settings?tab=chat')} className={ROW}>
            <SmilePlus size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {settings?.statusEmoji || settings?.statusText ? `${settings.statusEmoji ?? ''} ${settings.statusText ?? ''}`.trim() : "What's your status?"}
            </Text>
            <ChevronRight size={14} className="text-muted-foreground" />
          </Pressable>

          <Pressable
            role="menuitem"
            accessibilityLabel={pause.paused ? 'Notifications paused' : 'Pause notifications'}
            aria-expanded={pauseOpen}
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

      <Pressable role="menuitem" accessibilityLabel="Profile" onPress={() => go('/(app)/profile')} className={ROW}>
        <User size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">Profile</Text>
      </Pressable>
      <Popover
        placement="right top"
        offset={8}
        shouldFlip
        size="sm"
        className="h-auto w-auto"
        isOpen={appearanceOpen}
        onOpen={() => setAppearanceOpen(true)}
        onClose={() => setAppearanceOpen(false)}
        trigger={(triggerProps) => (
          <Pressable
            {...triggerProps}
            role="menuitem"
            accessibilityLabel="Appearance"
            accessibilityState={{ expanded: appearanceOpen }}
            onPress={() => setAppearanceOpen((open) => !open)}
            className={cn(ROW, appearanceOpen && "bg-muted")}
          >
            <Monitor size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground">Appearance</Text>
            <ChevronRight size={14} className="text-muted-foreground" />
          </Pressable>
        )}
      >
        <PopoverContent className="w-[200px] p-0" style={{ width: 200, padding: 0 }}>
          <PopoverBody>
            {model.theme && model.setTheme ? (
              <ThemeChoiceList theme={model.theme} onSelect={model.setTheme} variant="submenu" />
            ) : null}
          </PopoverBody>
        </PopoverContent>
      </Popover>
      <Pressable role="menuitem" accessibilityLabel="Settings" onPress={() => go('/(app)/settings')} className={ROW}>
        <Settings size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">Settings</Text>
      </Pressable>
      <Pressable role="menuitem" accessibilityLabel="Account and workspaces" onPress={() => go('/(app)/account')} className={ROW}>
        <UserRound size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">Account and workspaces</Text>
      </Pressable>
      {model.showCreator ? (
        <Pressable role="menuitem" accessibilityLabel="Creator" onPress={() => go('/(app)/creator')} className={ROW}>
          <Store size={16} className="text-muted-foreground" />
          <Text className="flex-1 text-sm text-foreground">Creator</Text>
        </Pressable>
      ) : null}
      {model.isSuperAdmin ? (
        <Pressable role="menuitem" accessibilityLabel="Admin panel" onPress={() => go('/(admin)')} className={ROW}>
          <Shield size={16} className="text-primary" />
          <Text className="flex-1 text-sm text-foreground">Admin</Text>
        </Pressable>
      ) : null}
      {!model.localMode && signOut ? (
        <>
          <View className="my-1 h-px bg-border" />
          <Pressable role="menuitem" accessibilityLabel="Sign out" onPress={signOut} className={ROW}>
            <LogOut size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground">Sign Out</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  )
}

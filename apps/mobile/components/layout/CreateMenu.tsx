// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "+" menu. It leads with working with agents, then the ways to start a
 * conversation or a project. Used by the desktop rail and the mobile
 * floating button.
 */
import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { FolderPlus, Hash, ListTodo, MessageSquarePlus, Sparkles } from 'lucide-react-native'
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover'
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TASKS_NAV_HIDDEN } from '../../../../packages/shared-app/src/hooks/useWorkspaceExperience'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'

export interface CreateMenuItem {
  id: string
  label: string
  icon: React.ElementType
  /** Navigate here, or run `run`. */
  href?: string
  run?: () => void
}

/** The menu's items for the current workspace. Pure, so it can be tested. */
export function createMenuItems(opts: { teamChat: boolean; startCreate: (mode: 'channel' | 'dm' | 'agent') => void }): CreateMenuItem[] {
  return [
    { id: 'ask-agent', label: 'Ask an agent', icon: Sparkles, href: '/(app)/agent' },
    ...(TASKS_NAV_HIDDEN ? [] : [{ id: 'start-task', label: 'Start a task', icon: ListTodo, href: '/(app)/tasks' }]),
    { id: 'new-project', label: 'New project', icon: FolderPlus, href: '/(app)/new-project' },
    ...(opts.teamChat
      ? [
          { id: 'new-message', label: 'New message', icon: MessageSquarePlus, run: () => opts.startCreate('dm') },
          { id: 'new-channel', label: 'Create channel', icon: Hash, run: () => opts.startCreate('channel') },
        ]
      : []),
  ]
}

export interface CreateMenuProps {
  placement?: 'right bottom' | 'top right' | 'top left' | 'bottom right'
  /** Renders the button; spread `props` onto a Pressable. */
  children: (props: Record<string, unknown> & { open: boolean }) => ReactNode
}

export function CreateMenu({ placement = 'right bottom', children }: CreateMenuProps) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const [open, setOpen] = useState(false)
  const items = createMenuItems({ teamChat: chat.enabled, startCreate: chat.startCreate })
  return (
    <Popover
      placement={placement}
      size="sm"
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={(triggerProps) => children({ ...triggerProps, open })}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[220px] p-0">
        <PopoverBody>
          <View role="menu" className="py-1" testID="create-menu">
            {items.map(({ id, label, icon: Icon, href, run }) => (
              <Pressable
                key={id}
                role="menuitem"
                accessibilityLabel={label}
                onPress={() => {
                  setOpen(false)
                  if (href) router.push(href as any)
                  else run?.()
                }}
                className="flex-row items-center gap-3 px-3 py-2.5 active:bg-muted"
              >
                <Icon size={16} className="text-muted-foreground" />
                <Text className="text-sm text-foreground">{label}</Text>
              </Pressable>
            ))}
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

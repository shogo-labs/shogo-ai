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
import { FolderPlus, Hash, ListTodo, MessageSquarePlus, Sparkles, UserPlus } from 'lucide-react-native'
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover'
import { useTeamChatNav } from '../team-chat/TeamChatSidebarProvider'
import { useInviteDialog } from '../workspace/invite-dialog-context'
import { usePermissions } from '../../hooks/usePermissions'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { createMenuItems } from './create-menu-items'

export type { CreateMenuItem } from './create-menu-items'

const MENU_ICONS: Record<string, React.ElementType> = {
  'ask-agent': Sparkles,
  'start-task': ListTodo,
  'new-project': FolderPlus,
  'new-message': MessageSquarePlus,
  'new-channel': Hash,
  'invite-people': UserPlus,
}

export interface CreateMenuProps {
  placement?: 'right bottom' | 'top right' | 'top left' | 'bottom right'
  /** Renders the button; spread `props` onto a Pressable. */
  children: (props: Record<string, unknown> & { open: boolean }) => ReactNode
}

export function CreateMenu({ placement = 'right bottom', children }: CreateMenuProps) {
  const router = useRouter()
  const chat = useTeamChatNav()
  const inviteDialog = useInviteDialog()
  const workspace = useActiveWorkspace()
  const { canInvite } = usePermissions({ workspaceId: workspace?.id })
  const [open, setOpen] = useState(false)
  const items = createMenuItems({
    teamChat: chat.enabled,
    startCreate: chat.startCreate,
    onInvite: canInvite ? () => inviteDialog.openInviteDialog(workspace?.id ?? null) : undefined,
  })
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
            {items.map(({ id, label, href, run }) => {
              const Icon = MENU_ICONS[id] ?? Sparkles
              return (
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
              )
            })}
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

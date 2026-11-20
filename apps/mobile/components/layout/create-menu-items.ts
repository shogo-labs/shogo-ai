// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "+" menu's items, kept free of React Native and router imports so the
 * list can be unit-tested. `CreateMenu` attaches the icons and renders them.
 */
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { TASKS_NAV_HIDDEN } from '../../../../packages/shared-app/src/hooks/useWorkspaceExperience'

export interface CreateMenuItem {
  id: string
  label: string
  /** Navigate here, or run `run`. */
  href?: string
  run?: () => void
}

/**
 * The menu's items for the current workspace. `onInvite` is present only when
 * the caller may invite (SHO-454).
 */
export function createMenuItems(opts: {
  teamChat: boolean
  startCreate: (mode: 'channel' | 'message' | 'agent') => void
  onInvite?: () => void
}): CreateMenuItem[] {
  return [
    { id: 'ask-agent', label: 'Ask an agent', href: '/(app)/agent' },
    ...(TASKS_NAV_HIDDEN ? [] : [{ id: 'start-task', label: 'Start a task', href: '/(app)/tasks' }]),
    { id: 'new-project', label: 'New project', href: '/(app)/new-project' },
    ...(opts.teamChat
      ? [
          { id: 'new-message', label: 'New message', run: () => opts.startCreate('message') },
          { id: 'new-channel', label: 'Create channel', run: () => opts.startCreate('channel') },
        ]
      : []),
    ...(opts.onInvite ? [{ id: 'invite-people', label: 'Invite people', run: opts.onInvite }] : []),
  ]
}

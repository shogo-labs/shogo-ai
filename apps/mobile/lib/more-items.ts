// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** What the More tab lists. Only destinations that exist for this workspace. */
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { CANVAS_NAV_HIDDEN, TASKS_NAV_HIDDEN } from '../../../packages/shared-app/src/hooks/useWorkspaceExperience'

export type MoreIcon = 'analytics' | 'tasks' | 'work' | 'marketplace' | 'files' | 'social' | 'settings'

export interface MoreItem {
  id: string
  icon: MoreIcon
  title: string
  subtitle: string
  href: string
}

export function moreItems(opts: { kind: 'personal' | 'team'; marketplace: boolean; canvasesHidden?: boolean; tasksHidden?: boolean; workBoards?: boolean; social?: boolean }): MoreItem[] {
  // Usage and cost optimizer: every workspace kind, local included.
  const items: MoreItem[] = [
    { id: 'analytics', icon: 'analytics', title: 'Analytics', subtitle: 'Workspace usage and the cost optimizer', href: '/(app)/analytics' },
  ]
  if (opts.kind === 'team') {
    if (opts.workBoards) items.push({ id: 'work', icon: 'work', title: 'My work', subtitle: 'Your cards across every board', href: '/(app)/work' })
    if (!(opts.tasksHidden ?? TASKS_NAV_HIDDEN)) items.push({ id: 'tasks', icon: 'tasks', title: 'Tasks', subtitle: 'Work assigned to you and to your agents', href: '/(app)/tasks' })
    if (opts.marketplace) {
      items.push({ id: 'marketplace', icon: 'marketplace', title: 'Marketplace', subtitle: 'Find agents and templates', href: '/(app)/marketplace' })
    }
  }
  // Only when the workspace has a connected account: a link that 403s on a
  // workspace with social management switched off is worse than no link.
  if (opts.social) {
    items.push({ id: 'social', icon: 'social', title: 'Social', subtitle: 'Publish, calendar, inbox, comments and automations', href: '/(app)/social' })
  }
  if (!(opts.canvasesHidden ?? CANVAS_NAV_HIDDEN)) {
    items.push({ id: 'files', icon: 'files', title: 'Files', subtitle: 'Canvases and files from you and your agents', href: '/(app)/canvases' })
  }
  items.push({ id: 'settings', icon: 'settings', title: 'Settings', subtitle: 'Account, workspace, integrations and billing', href: '/(app)/settings' })
  return items
}

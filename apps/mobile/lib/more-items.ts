// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** What the More tab lists. Only destinations that exist for this workspace. */
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import { CANVAS_NAV_HIDDEN } from '../../../packages/shared-app/src/hooks/useWorkspaceExperience'

export type MoreIcon = 'tasks' | 'marketplace' | 'side-chats' | 'files'

export interface MoreItem {
  id: string
  icon: MoreIcon
  title: string
  subtitle: string
  href: string
}

export function moreItems(opts: { kind: 'personal' | 'team'; marketplace: boolean; canvasesHidden?: boolean }): MoreItem[] {
  const items: MoreItem[] = []
  if (opts.kind === 'team') {
    items.push({ id: 'tasks', icon: 'tasks', title: 'Tasks', subtitle: 'Work assigned to you and to your agents', href: '/(app)/tasks' })
    if (opts.marketplace) {
      items.push({ id: 'marketplace', icon: 'marketplace', title: 'Marketplace', subtitle: 'Find agents and templates', href: '/(app)/marketplace' })
    }
  } else {
    items.push({ id: 'side-chats', icon: 'side-chats', title: 'Side chats', subtitle: 'Explore a tangent without leaving your main chat', href: '/(app)/side-chats' })
  }
  if (!(opts.canvasesHidden ?? CANVAS_NAV_HIDDEN)) {
    items.push({ id: 'files', icon: 'files', title: 'Files', subtitle: 'Canvases and files from you and your agents', href: '/(app)/canvases' })
  }
  return items
}

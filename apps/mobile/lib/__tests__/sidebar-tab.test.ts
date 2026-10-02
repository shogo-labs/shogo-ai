// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { dockTabForPathname, hrefForTab, resolveTab, tabForPathname, type TabConversation } from '../sidebar-tab'

const conversations: TabConversation[] = [
  { id: 'ch1', kind: 'public' },
  { id: 'ch2', kind: 'private' },
  { id: 'dm1', kind: 'dm' },
  { id: 'dm2', kind: 'group_dm' },
]

describe('tabForPathname', () => {
  test('the workspace agent chat belongs to Home, and the phone More screen to More', () => {
    expect(tabForPathname('/agent')).toBe('home')
    expect(tabForPathname('/(app)/agent')).toBe('home')
    expect(tabForPathname('/(app)/more')).toBe('more')
    expect(tabForPathname('/c/dms')).toBe('dms')
  })

  test('home, with or without the route group', () => {
    expect(tabForPathname('/')).toBe('home')
    expect(tabForPathname('/(app)')).toBe('home')
    expect(tabForPathname('/(app)/')).toBe('home')
  })

  test('a conversation belongs to Channels or DMs by its kind', () => {
    expect(tabForPathname('/c/ch1', conversations)).toBe('channels')
    expect(tabForPathname('/(app)/c/ch2', conversations)).toBe('channels')
    expect(tabForPathname('/c/dm1', conversations)).toBe('dms')
    expect(tabForPathname('/c/dm2', conversations)).toBe('dms')
  })

  test('an unknown conversation keeps the current tab until the list arrives', () => {
    expect(tabForPathname('/c/nope', conversations)).toBeNull()
    expect(tabForPathname('/c/ch1')).toBeNull()
  })

  test('chat utility routes', () => {
    expect(tabForPathname('/c')).toBe('channels')
    expect(tabForPathname('/c/search')).toBe('channels')
    expect(tabForPathname('/c/settings')).toBe('channels')
    expect(tabForPathname('/c/inbox')).toBe('activity')
    expect(tabForPathname('/c/later')).toBe('home')
    expect(tabForPathname('/c/dms')).toBe('dms')
  })

  test('project routes belong to Projects', () => {
    for (const path of ['/projects', '/projects/p1', '/project-chat/p1', '/project-surface/p1', '/new-project']) {
      expect(tabForPathname(path)).toBe('projects')
    }
  })

  test('activity, personal pages and the More items', () => {
    expect(tabForPathname('/activity')).toBe('activity')
    expect(tabForPathname('/meetings/m1')).toBe('meetings')
    expect(tabForPathname('/goals')).toBe('goals')
    for (const path of ['/tasks', '/canvases', '/marketplace/some-agent', '/files']) {
      expect(tabForPathname(path)).toBe('more')
    }
  })

  test('routes with no tab leave the current one alone', () => {
    expect(tabForPathname('/settings')).toBeNull()
    expect(tabForPathname('/billing')).toBeNull()
    expect(tabForPathname('/account')).toBeNull()
  })

  test('does not mistake a path that merely starts with c for chat', () => {
    expect(tabForPathname('/canvases')).toBe('more')
    expect(tabForPathname('/creator')).toBeNull()
  })
})

describe('tabs that are pages', () => {
  test('meetings and goals navigate; panel tabs do not', () => {
    expect(hrefForTab('meetings')).toBe('/(app)/meetings')
    expect(hrefForTab('goals')).toBe('/(app)/goals')
    expect(hrefForTab('channels')).toBeNull()
    expect(hrefForTab('home')).toBeNull()
  })
})

describe('resolveTab', () => {
  const team = ['home', 'channels', 'dms', 'agents', 'projects', 'activity', 'more'] as const
  test('uses the stored tab when this workspace offers it', () => {
    expect(resolveTab('dms', [...team])).toBe('dms')
  })
  test('falls back to the first tab for a missing or unavailable one', () => {
    expect(resolveTab(null, [...team])).toBe('home')
    expect(resolveTab('channels', ['home', 'meetings', 'goals', 'activity', 'more'])).toBe('home')
  })
})

describe('phone dock', () => {
  test('channels, agents and projects are Home; DMs, Activity and More are themselves', () => {
    expect(dockTabForPathname('/(app)')).toBe('home')
    expect(dockTabForPathname('/c/ch1', conversations)).toBe('home')
    expect(dockTabForPathname('/projects/p1')).toBe('home')
    expect(dockTabForPathname('/c/dm1', conversations)).toBe('dms')
    expect(dockTabForPathname('/c/dms')).toBe('dms')
    expect(dockTabForPathname('/activity')).toBe('activity')
    expect(dockTabForPathname('/c/inbox')).toBe('activity')
    expect(dockTabForPathname('/tasks')).toBe('more')
    expect(dockTabForPathname('/meetings')).toBe('more')
  })
})

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { moreItems } from '../more-items'

const ids = (items: ReturnType<typeof moreItems>) => items.map((i) => i.id)

describe('moreItems', () => {
  test('Analytics is listed first for every workspace kind, local personal included', () => {
    const analytics = moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true }).find((i) => i.id === 'analytics')
    expect(analytics?.href).toBe('/(app)/analytics')
    expect(ids(moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true }))).toEqual(['analytics', 'settings'])
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: false }))[0]).toBe('analytics')
  })

  test('a team workspace lists Marketplace, and Tasks only when its navigation is switched on', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: true }))).toEqual(['analytics', 'marketplace', 'settings'])
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: true, tasksHidden: false }))).toEqual(['analytics', 'tasks', 'marketplace', 'settings'])
  })

  test('My work follows the work boards flag, in team workspaces only', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: false, canvasesHidden: true, workBoards: true }))).toEqual(['analytics', 'work', 'settings'])
    expect(ids(moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true, workBoards: true }))).toEqual(['analytics', 'settings'])
  })

  test('Marketplace follows the platform feature flag', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: false, canvasesHidden: true }))).toEqual(['analytics', 'settings'])
  })

  test('a personal workspace has no Tasks, Marketplace, or Side chats', () => {
    expect(ids(moreItems({ kind: 'personal', marketplace: true, canvasesHidden: true }))).toEqual(['analytics', 'settings'])
  })

  test('Files appears only when canvas navigation is switched back on', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: false }))).toEqual(['analytics', 'marketplace', 'files', 'settings'])
  })

  test('Settings is always last and opens the settings screen', () => {
    const scenarios = [
      { kind: 'personal' as const, marketplace: false, canvasesHidden: true },
      { kind: 'personal' as const, marketplace: true, canvasesHidden: false, workBoards: true },
      { kind: 'team' as const, marketplace: false, canvasesHidden: true },
      { kind: 'team' as const, marketplace: true, canvasesHidden: false, tasksHidden: false, workBoards: true },
    ]
    for (const opts of scenarios) {
      const items = moreItems(opts)
      const last = items[items.length - 1]
      expect(last.id).toBe('settings')
      expect(last.title).toBe('Settings')
      expect(last.href).toBe('/(app)/settings')
    }
  })

  test('every item has a destination and a one-line description', () => {
    for (const item of moreItems({ kind: 'team', marketplace: true, canvasesHidden: false })) {
      expect(item.href.startsWith('/(app)/')).toBe(true)
      expect(item.subtitle.length).toBeGreaterThan(0)
    }
  })
})

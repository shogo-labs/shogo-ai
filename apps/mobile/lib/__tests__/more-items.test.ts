// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { moreItems } from '../more-items'

const ids = (items: ReturnType<typeof moreItems>) => items.map((i) => i.id)

describe('moreItems', () => {
  test('Analytics is listed first for every workspace kind, local personal included', () => {
    const analytics = moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true }).find((i) => i.id === 'analytics')
    expect(analytics?.href).toBe('/(app)/analytics')
    expect(ids(moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true }))).toEqual(['analytics'])
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: false }))[0]).toBe('analytics')
  })

  test('a team workspace lists Marketplace, and Tasks only when its navigation is switched on', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: true }))).toEqual(['analytics', 'marketplace'])
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: true, tasksHidden: false }))).toEqual(['analytics', 'tasks', 'marketplace'])
  })

  test('My work follows the work boards flag, in team workspaces only', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: false, canvasesHidden: true, workBoards: true }))).toEqual(['analytics', 'work'])
    expect(ids(moreItems({ kind: 'personal', marketplace: false, canvasesHidden: true, workBoards: true }))).toEqual(['analytics'])
  })

  test('Marketplace follows the platform feature flag', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: false, canvasesHidden: true }))).toEqual(['analytics'])
  })

  test('a personal workspace has no Tasks, Marketplace, or Side chats', () => {
    expect(ids(moreItems({ kind: 'personal', marketplace: true, canvasesHidden: true }))).toEqual(['analytics'])
  })

  test('Files appears only when canvas navigation is switched back on', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: false }))).toEqual(['analytics', 'marketplace', 'files'])
  })

  test('every item has a destination and a one-line description', () => {
    for (const item of moreItems({ kind: 'team', marketplace: true, canvasesHidden: false })) {
      expect(item.href.startsWith('/(app)/')).toBe(true)
      expect(item.subtitle.length).toBeGreaterThan(0)
    }
  })
})

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { moreItems } from '../more-items'

const ids = (items: ReturnType<typeof moreItems>) => items.map((i) => i.id)

describe('moreItems', () => {
  test('a team workspace lists Tasks and Marketplace', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: true }))).toEqual(['tasks', 'marketplace'])
  })

  test('Marketplace follows the platform feature flag', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: false, canvasesHidden: true }))).toEqual(['tasks'])
  })

  test('a personal workspace has Side chats instead, and no Tasks or Marketplace', () => {
    expect(ids(moreItems({ kind: 'personal', marketplace: true, canvasesHidden: true }))).toEqual(['side-chats'])
  })

  test('Files appears only when canvas navigation is switched back on', () => {
    expect(ids(moreItems({ kind: 'team', marketplace: true, canvasesHidden: false }))).toEqual(['tasks', 'marketplace', 'files'])
  })

  test('every item has a destination and a one-line description', () => {
    for (const item of moreItems({ kind: 'team', marketplace: true, canvasesHidden: false })) {
      expect(item.href.startsWith('/(app)/')).toBe(true)
      expect(item.subtitle.length).toBeGreaterThan(0)
    }
  })
})

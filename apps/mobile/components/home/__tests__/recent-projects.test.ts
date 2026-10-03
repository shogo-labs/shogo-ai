// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'

// Pure helper; imported through the module path without the React tree.
const { recentProjects } = await import('../recentProjects')

describe('recentProjects', () => {
  const all = [
    { id: 'a', workspaceId: 'w1', updatedAt: '2026-01-01' },
    { id: 'b', workspaceId: 'w1', updatedAt: '2026-03-01' },
    { id: 'c', workspaceId: 'w2', updatedAt: '2026-04-01' },
    { id: 'd', workspaceId: 'w1' },
  ]

  test('keeps only this workspace, newest first, undated last', () => {
    expect(recentProjects(all, 'w1').map((p) => p.id)).toEqual(['b', 'a', 'd'])
  })

  test('limits the list and does not mutate the input', () => {
    const copy = [...all]
    expect(recentProjects(all, 'w1', 2)).toHaveLength(2)
    expect(all).toEqual(copy)
  })

  test('without a workspace id shows everything', () => {
    expect(recentProjects(all, null)).toHaveLength(4)
  })
})

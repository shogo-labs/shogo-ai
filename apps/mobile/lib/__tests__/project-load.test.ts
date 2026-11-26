// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-581 (the switch half of SHO-580's §C): `loadAll({ workspaceId })` merges
 * into the shared collection, so mid-switch the collection still holds the
 * workspace just left. Those rows must not count as the new workspace's answer
 * — the screen reads "the network answered" from this list, and a departed
 * workspace's rows made it draw an empty list instead of the destination's
 * cached rows (and wrote them into the destination's cache).
 */

import { describe, expect, test } from 'bun:test'
import { rowsInWorkspace } from '../project-load'

const row = (id: string, workspaceId?: string) => ({ id, workspaceId })

describe('rowsInWorkspace', () => {
  test('keeps only the workspace being shown', () => {
    const rows = [row('a', 'ws-1'), row('b', 'ws-2'), row('c', 'ws-1')]
    expect(rowsInWorkspace(rows, 'ws-1').map((r) => r.id)).toEqual(['a', 'c'])
    expect(rowsInWorkspace(rows, 'ws-2').map((r) => r.id)).toEqual(['b'])
  })

  test('a switch shows nothing until the destination answers', () => {
    const fromPreviousWorkspace = [row('a', 'ws-1'), row('b', 'ws-1')]
    expect(rowsInWorkspace(fromPreviousWorkspace, 'ws-2')).toEqual([])
  })

  test('an all-workspaces list keeps every row', () => {
    const rows = [row('a', 'ws-1'), row('b', 'ws-2')]
    expect(rowsInWorkspace(rows, 'ws-1', true).map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('no scope keeps every row', () => {
    const rows = [row('a', 'ws-1'), row('b', 'ws-2')]
    expect(rowsInWorkspace(rows, null).map((r) => r.id)).toEqual(['a', 'b'])
    expect(rowsInWorkspace(rows, undefined).map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('does not mutate or alias the collection it was given', () => {
    const rows = [row('a', 'ws-1')]
    const scoped = rowsInWorkspace(rows, 'ws-1')
    expect(scoped).not.toBe(rows)
    scoped.push(row('b', 'ws-1'))
    expect(rows).toHaveLength(1)
  })
})

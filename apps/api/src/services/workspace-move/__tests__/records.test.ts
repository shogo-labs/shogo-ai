// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Row rewriting is the part that has to be exactly idempotent: a resumed move
 * re-sends its last chunk, and the same source row must land on the same target
 * primary key every time. These tests pin that, plus the two rules that are easy
 * to get wrong — account columns must not be remapped, and nothing that runs on
 * a timer may arrive enabled.
 */

import { describe, expect, test } from 'bun:test'
import { deriveMoveId } from '../ids'
import { chunkRows, prepareModelRows, rewriteRowForMove, shouldMoveModel } from '../records'

const ctx = {
  moveId: '11111111-2222-3333-4444-555555555555',
  sourceWorkspaceId: 'ws-source',
  targetWorkspaceId: 'ws-target',
  movedIds: new Set(['p1', 'c1', 'm1']),
}

describe('deriveMoveId', () => {
  test('is stable and per-move', () => {
    const a = deriveMoveId(ctx.moveId, 'p1')
    expect(a).toBe(deriveMoveId(ctx.moveId, 'p1'))
    expect(a).not.toBe(deriveMoveId(ctx.moveId, 'p2'))
    expect(a).not.toBe(deriveMoveId('99999999-2222-3333-4444-555555555555', 'p1'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('rewriteRowForMove', () => {
  test('derives the id and every foreign key that points at a moved row', () => {
    const row = { id: 'p1', workspaceId: 'ws-source', name: 'Content Studio', parentProjectId: 'c1' }
    const next = rewriteRowForMove('Project', row, ctx)
    expect(next.id).toBe(deriveMoveId(ctx.moveId, 'p1'))
    expect(next.workspaceId).toBe('ws-target')
    expect(next.parentProjectId).toBe(deriveMoveId(ctx.moveId, 'c1'))
    expect(next.name).toBe('Content Studio')
  })

  test('never remaps an account or an outside-system id', () => {
    const row = { id: 'm1', workspaceId: 'ws-source', userId: 'p1', ownerUserId: 'c1', installId: 'p1' }
    const next = rewriteRowForMove('Member', row, ctx)
    expect(next.userId).toBe('p1')
    expect(next.ownerUserId).toBe('c1')
    expect(next.installId).toBe('p1')
  })

  test('a foreign key to a row that is not moving is left alone', () => {
    const next = rewriteRowForMove('WorkItem', { id: 'w1', workspaceId: 'ws-source', assigneeUserId: 'u9' }, ctx)
    expect(next.assigneeUserId).toBe('u9')
  })

  test('schedules and triggers arrive disabled, with no stale run marker', () => {
    const schedule = rewriteRowForMove(
      'AgentSchedule',
      { id: 's1', workspaceId: 'ws-source', enabled: true, runningAt: '2026-10-28T10:00:00Z', consecutiveFailures: 4, lastError: 'boom' },
      ctx,
    )
    expect(schedule.enabled).toBe(false)
    expect(schedule.runningAt).toBeNull()
    expect(schedule.consecutiveFailures).toBe(0)
    expect(schedule.lastError).toBeNull()

    const trigger = rewriteRowForMove('EventSubscription', { id: 't1', workspaceId: 'ws-source', enabled: true }, ctx)
    expect(trigger.enabled).toBe(false)
  })

  test('ProjectFolder never travels: the target decides where a checkout lives', () => {
    expect(shouldMoveModel('ProjectFolder')).toBe(false)
    expect(prepareModelRows('ProjectFolder', [{ id: 'f1', projectId: 'p1', path: '/Users/me/code/x' }], ctx)).toEqual([])
  })

  test('rewriting twice is the same as rewriting once', () => {
    const row = { id: 'p1', workspaceId: 'ws-source', parentProjectId: 'c1' }
    const once = rewriteRowForMove('Project', row, ctx)
    const twice = rewriteRowForMove('Project', row, ctx)
    expect(twice).toEqual(once)
  })

  test('the target workspace never inherits the source move bookkeeping', () => {
    const rewritten = rewriteRowForMove(
      'Workspace',
      { id: 'ws-source', movedToWorkspaceId: 'ws-target', movedAt: '2026-10-28T20:00:00.000Z' },
      ctx,
    )
    expect(rewritten.movedToWorkspaceId).toBeNull()
    expect(rewritten.movedAt).toBeNull()
  })
})

describe('chunking', () => {
  test('splits rows into resumable chunks', () => {
    const rows = Array.from({ length: 1201 }, (_, index) => ({ id: `r${index}` }))
    const chunks = chunkRows(rows, 500)
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 201])
    expect(chunks.flat()).toHaveLength(1201)
  })

  test('an empty model produces no chunks', () => {
    expect(prepareModelRows('Project', [], ctx)).toEqual([])
  })
})

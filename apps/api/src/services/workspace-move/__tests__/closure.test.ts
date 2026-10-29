// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The guard that keeps a partial move honest.
 *
 * "Move these two channels and this agent" is only well defined if every model
 * has a decided way of joining the closure. A model added without a rule would
 * either travel in every partial move (leaking one channel's content into
 * another) or vanish from all of them, so this test fails with the exact list
 * of undecided models — the same contract `manifest-coverage.test.ts` holds for
 * the archive.
 */

import { describe, expect, test } from 'bun:test'
import { applySelectionClosure, closureRuleFor, modelsWithoutClosureRule } from '../closure'
import { insertOrder, scopeFor } from '../../workspace-export/manifest'
import type { MoveRow } from '../types'

function snapshot(rows: Record<string, MoveRow[]>): Map<string, MoveRow[]> {
  return new Map(Object.entries(rows))
}

describe('selection closure coverage', () => {
  test('every model a move can carry has a closure rule', () => {
    expect(modelsWithoutClosureRule()).toEqual([])
  })

  test('a workspace-scoped model is never left to a default', () => {
    // The export scope says "belongs to the workspace"; only the closure table
    // says how it joins a *partial* move.
    const undecided = insertOrder().filter((model) => {
      if (scopeFor(model)?.kind !== 'workspace') return false
      return closureRuleFor(model) === null
    })
    expect(undecided).toEqual([])
  })
})

describe('applySelectionClosure', () => {
  const rows = snapshot({
    Workspace: [{ id: 'ws' }],
    Member: [{ id: 'm1', workspaceId: 'ws' }],
    Conversation: [
      { id: 'c1', workspaceId: 'ws', kind: 'channel' },
      { id: 'c2', workspaceId: 'ws', kind: 'channel' },
    ],
    ConversationMessage: [
      { id: 'msg1', conversationId: 'c1' },
      { id: 'msg2', conversationId: 'c2' },
    ],
    Board: [
      { id: 'b1', workspaceId: 'ws', conversationId: 'c1' },
      { id: 'b2', workspaceId: 'ws', conversationId: 'c2' },
    ],
    BoardColumn: [
      { id: 'col1', boardId: 'b1' },
      { id: 'col2', boardId: 'b2' },
    ],
    WorkItem: [
      { id: 'w1', workspaceId: 'ws', boardId: 'b1' },
      { id: 'w2', workspaceId: 'ws', boardId: 'b2' },
    ],
    Project: [
      { id: 'p1', workspaceId: 'ws' },
      { id: 'p2', workspaceId: 'ws' },
    ],
    AgentConfig: [
      { id: 'ac1', projectId: 'p1' },
      { id: 'ac2', projectId: 'p2' },
    ],
    AgentSchedule: [
      { id: 's1', workspaceId: 'ws', chatSessionId: 'cs1', name: 'morning' },
      { id: 's2', workspaceId: 'ws', chatSessionId: 'cs2', name: 'other project' },
    ],
    ChatSession: [
      { id: 'cs1', workspaceId: 'ws', projectId: 'p1' },
      { id: 'cs2', workspaceId: 'ws', projectId: 'p2' },
    ],
  })

  test('mode all keeps everything', () => {
    const result = applySelectionClosure(rows, { mode: 'all' })
    expect(result.rows.get('Conversation')).toHaveLength(2)
    expect(result.rows.get('WorkItem')).toHaveLength(2)
  })

  test('one channel brings its board, columns and cards — and nothing from the other', () => {
    const result = applySelectionClosure(rows, {
      mode: 'selected',
      conversationIds: ['c1'],
      projectIds: [],
    })
    const ids = (model: string) => (result.rows.get(model) ?? []).map((row) => row.id)
    expect(ids('Conversation')).toEqual(['c1'])
    expect(ids('ConversationMessage')).toEqual(['msg1'])
    expect(ids('Board')).toEqual(['b1'])
    expect(ids('BoardColumn')).toEqual(['col1'])
    expect(ids('WorkItem')).toEqual(['w1'])
    // Nothing about the project side was selected.
    expect(ids('Project')).toEqual([])
    expect(ids('AgentSchedule')).toEqual([])
  })

  test('one project brings its agent config and the schedules of its chats', () => {
    const result = applySelectionClosure(rows, {
      mode: 'selected',
      conversationIds: [],
      projectIds: ['p1'],
    })
    const ids = (model: string) => (result.rows.get(model) ?? []).map((row) => row.id)
    expect(ids('Project')).toEqual(['p1'])
    expect(ids('AgentConfig')).toEqual(['ac1'])
    expect(ids('ChatSession')).toEqual(['cs1'])
    expect(ids('AgentSchedule')).toEqual(['s1'])
  })

  test('workspace furniture always travels', () => {
    const result = applySelectionClosure(rows, { mode: 'selected', conversationIds: ['c1'], projectIds: [] })
    expect(result.rows.get('Workspace')).toHaveLength(1)
    expect(result.rows.get('Member')).toHaveLength(1)
  })

  test('counts are reported in insert order', () => {
    const result = applySelectionClosure(rows, { mode: 'all' })
    const models = result.counts.map((entry) => entry.model)
    const order = [...insertOrder()]
    for (let i = 1; i < models.length; i++) {
      expect(order.indexOf(models[i]!)).toBeGreaterThan(order.indexOf(models[i - 1]!))
    }
  })
})

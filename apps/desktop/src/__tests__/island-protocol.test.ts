// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  mergeIslandSnapshots,
  parseIslandAction,
  parseIslandConfigPatch,
  parseIslandSnapshot,
  type IslandSnapshot,
} from '../island-protocol'

function session(projectId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return { projectId, sessionId, projectName: projectId, title: sessionId, status: 'idle' as const, ...extra }
}

describe('parseIslandAction', () => {
  test('accepts a well-formed send with file refs', () => {
    expect(
      parseIslandAction({
        type: 'send',
        target: { kind: 'session', projectId: 'p1', sessionId: 's1' },
        text: 'hi',
        files: [{ path: '/tmp/a.txt', name: 'a.txt', type: 'text/plain' }],
      }),
    ).toEqual({
      type: 'send',
      target: { kind: 'session', projectId: 'p1', sessionId: 's1' },
      text: 'hi',
      files: [{ path: '/tmp/a.txt', name: 'a.txt', type: 'text/plain' }],
    })
  })

  test('rejects empty sends, unknown decisions, and malformed targets', () => {
    expect(parseIslandAction({ type: 'send', target: { kind: 'new', projectId: 'p1' }, text: '  ' })).toBeNull()
    expect(parseIslandAction({ type: 'permission', requestId: 'r1', decision: 'maybe' })).toBeNull()
    expect(parseIslandAction({ type: 'open', projectId: 'p1' })).toBeNull()
    expect(parseIslandAction({ type: 'send', target: { kind: 'session', projectId: 'p1' }, text: 'x' })).toBeNull()
    expect(parseIslandAction('open')).toBeNull()
  })
})

describe('parseIslandSnapshot', () => {
  test('drops invalid sessions and routes option-less questions to the app', () => {
    const parsed = parseIslandSnapshot({
      sessions: [
        session('p1', 's1', {
          status: 'bogus',
          pending: { kind: 'question', request: { id: 'q1', prompt: 'Pick', options: [] } },
        }),
        { projectId: 'p1' },
      ],
      recentProjects: [{ projectId: 'p1', name: 'One' }, { name: 'missing id' }],
    })
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].status).toBe('idle')
    expect(parsed.sessions[0].pending).toEqual({
      kind: 'question',
      request: { id: 'q1', prompt: 'Pick', options: [], answerInApp: true },
    })
    expect(parsed.recentProjects).toEqual([{ projectId: 'p1', name: 'One' }])
  })
})

describe('mergeIslandSnapshots', () => {
  test('keeps every window and prefers the most recently updated duplicate', () => {
    const older: IslandSnapshot = {
      sessions: [session('p1', 's1', { title: 'stale' }), session('p2', 's2')],
      recentProjects: [{ projectId: 'p1', name: 'One' }, { projectId: 'p2', name: 'Two' }],
      updatedAt: 1,
    }
    const newer: IslandSnapshot = {
      sessions: [session('p1', 's1', { title: 'fresh' })],
      recentProjects: [{ projectId: 'p1', name: 'One' }],
      updatedAt: 2,
    }
    const merged = mergeIslandSnapshots([older, newer])
    expect(merged.sessions.map((s) => `${s.sessionId}:${s.title}`)).toEqual(['s1:fresh', 's2:s2'])
    expect(merged.recentProjects.map((p) => p.projectId)).toEqual(['p1', 'p2'])
    expect(merged.updatedAt).toBe(2)
  })
})

describe('parseIslandConfigPatch', () => {
  test('accepts known fields and trims the shortcut', () => {
    expect(parseIslandConfigPatch({ enabled: false, shortcut: '  Alt+Space ' })).toEqual({
      ok: true,
      patch: { enabled: false, shortcut: 'Alt+Space' },
    })
  })

  test('rejects wrong types and blank shortcuts', () => {
    expect(parseIslandConfigPatch({ autoHide: 'yes' }).ok).toBe(false)
    expect(parseIslandConfigPatch({ shortcut: '   ' }).ok).toBe(false)
    expect(parseIslandConfigPatch(null).ok).toBe(false)
  })

  test('ignores unknown fields', () => {
    expect(parseIslandConfigPatch({ enabled: true, extra: 1 })).toEqual({ ok: true, patch: { enabled: true } })
  })
})

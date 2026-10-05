// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  BUDDY_EYEWEAR_IDS,
  BUDDY_FACE_IDS,
  BUDDY_FINISH_IDS,
  BUDDY_NECK_IDS,
  BUDDY_TAIL_IDS,
  BUDDY_TOPPER_IDS,
} from '../../../../packages/shared-app/src/buddy-look'
import {
  ISLAND_BUDDY_EYEWEAR,
  ISLAND_BUDDY_FACES,
  ISLAND_BUDDY_FINISHES,
  ISLAND_BUDDY_NECKS,
  ISLAND_BUDDY_TAILS,
  ISLAND_BUDDY_TOPPERS,
  ISLAND_MAX_PARAM_CHARS,
  mergeIslandSnapshots,
  parseIslandAction,
  parseIslandConfigPatch,
  parseIslandSnapshot,
  pendingRequestsToAutoExpand,
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

  test('parses stop and plan decisions', () => {
    expect(parseIslandAction({ type: 'stop', projectId: 'p1', sessionId: 's1' })).toEqual({
      type: 'stop',
      projectId: 'p1',
      sessionId: 's1',
    })
    expect(parseIslandAction({ type: 'plan', projectId: 'p1', sessionId: 's1', decision: 'build', modelId: 'm' })).toEqual({
      type: 'plan',
      projectId: 'p1',
      sessionId: 's1',
      decision: 'build',
      modelId: 'm',
    })
    expect(
      parseIslandAction({ type: 'plan', projectId: 'p1', sessionId: 's1', decision: 'feedback', text: ' tweak ' }),
    ).toEqual({ type: 'plan', projectId: 'p1', sessionId: 's1', decision: 'feedback', text: 'tweak' })
    expect(parseIslandAction({ type: 'plan', projectId: 'p1', sessionId: 's1', decision: 'feedback', text: ' ' })).toBeNull()
    expect(parseIslandAction({ type: 'plan', projectId: 'p1', sessionId: 's1', decision: 'ship' })).toBeNull()
  })

  test('only navigates to in-app paths', () => {
    expect(parseIslandAction({ type: 'navigate', path: '/billing' })).toEqual({ type: 'navigate', path: '/billing' })
    expect(parseIslandAction({ type: 'navigate', path: '//evil.example' })).toBeNull()
    expect(parseIslandAction({ type: 'navigate', path: 'https://evil.example' })).toBeNull()
  })

  test('accepts show-app', () => {
    expect(parseIslandAction({ type: 'show-app' })).toEqual({ type: 'show-app' })
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

  test('caps large permission params and keeps plans, activity, and focus', () => {
    const parsed = parseIslandSnapshot({
      focusedSessionKey: 'p1:s1',
      sessions: [
        session('p1', 's1', {
          lastActivityAt: 42,
          pending: {
            kind: 'permission',
            request: { id: 'r1', toolName: 'write_file', category: 'file_write', params: { content: 'x'.repeat(ISLAND_MAX_PARAM_CHARS + 5), path: 'a.ts' } },
          },
          pendingPlan: { name: 'Plan', overview: 'Do it', plan: '# Steps', todos: [{ id: 't1', content: 'One' }, { content: '' }] },
        }),
      ],
    })
    const [s] = parsed.sessions
    expect(parsed.focusedSessionKey).toBe('p1:s1')
    expect(s.lastActivityAt).toBe(42)
    expect(s.pending?.kind).toBe('permission')
    if (s.pending?.kind !== 'permission') throw new Error('expected permission')
    expect(s.pending.request.category).toBe('file_write')
    expect(s.pending.request.paramsTruncated).toBe(true)
    expect((s.pending.request.params.content as string).length).toBe(ISLAND_MAX_PARAM_CHARS)
    expect(s.pending.request.params.path).toBe('a.ts')
    expect(s.pendingPlan).toEqual({ name: 'Plan', overview: 'Do it', plan: '# Steps', todos: [{ id: 't1', content: 'One' }] })
  })

  test('drops empty plans', () => {
    const parsed = parseIslandSnapshot({ sessions: [session('p1', 's1', { pendingPlan: { name: 'Empty' } })] })
    expect(parsed.sessions[0].pendingPlan).toBeUndefined()
  })

  test('keeps a valid buddy look and drops a malformed one', () => {
    const look = {
      topper: 'fox',
      face: 'classic',
      tail: 'fox',
      eyewear: 'sunglasses',
      neck: 'scarf',
      bolts: false,
      blush: false,
      color: '#0D9488',
      finish: 'modern',
    }
    expect(parseIslandSnapshot({ sessions: [], buddyLook: look }).buddyLook).toEqual(look)
    expect(parseIslandSnapshot({ sessions: [], buddyLook: { ...look, color: '#0d9488' } }).buddyLook?.color).toBe('#0D9488')
    expect(parseIslandSnapshot({ sessions: [], buddyLook: { ...look, color: 'teal' } }).buddyLook?.color).toBeNull()
    expect(parseIslandSnapshot({ sessions: [], buddyLook: { ...look, topper: 'unicorn' } }).buddyLook).toBeUndefined()
    expect(parseIslandSnapshot({ sessions: [], buddyLook: { ...look, tail: 'lion' } }).buddyLook).toBeUndefined()
    expect(parseIslandSnapshot({ sessions: [], buddyLook: { ...look, bolts: 'yes' } }).buddyLook).toBeUndefined()
    expect(parseIslandSnapshot({ sessions: [], buddyLook: 'kitty' }).buddyLook).toBeUndefined()
  })

  test('defaults newer accessories for looks from older app windows', () => {
    expect(
      parseIslandSnapshot({ sessions: [], buddyLook: { topper: 'ears', face: 'screen', bolts: false, blush: false } })
        .buddyLook,
    ).toEqual({
      topper: 'ears',
      face: 'screen',
      tail: 'none',
      eyewear: 'none',
      neck: 'none',
      bolts: false,
      blush: false,
      color: null,
      finish: 'classic',
    })
  })

  // The desktop build can't import outside src/, so it keeps its own copy.
  test('buddy accessories match the shared look definition', () => {
    expect([...ISLAND_BUDDY_TOPPERS]).toEqual([...BUDDY_TOPPER_IDS])
    expect([...ISLAND_BUDDY_FACES]).toEqual([...BUDDY_FACE_IDS])
    expect([...ISLAND_BUDDY_TAILS]).toEqual([...BUDDY_TAIL_IDS])
    expect([...ISLAND_BUDDY_EYEWEAR]).toEqual([...BUDDY_EYEWEAR_IDS])
    expect([...ISLAND_BUDDY_NECKS]).toEqual([...BUDDY_NECK_IDS])
    expect([...ISLAND_BUDDY_FINISHES]).toEqual([...BUDDY_FINISH_IDS])
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

  test('takes the buddy look from the most recently updated window that has one', () => {
    const base = { tail: 'none', eyewear: 'none', neck: 'none', color: null, finish: 'classic' } as const
    const kitty = { ...base, topper: 'ears', face: 'classic', bolts: false, blush: true } as const
    const visor = { ...base, topper: 'stubby', face: 'visor', bolts: true, blush: false } as const
    const older: IslandSnapshot = { sessions: [], recentProjects: [], buddyLook: kitty, updatedAt: 1 }
    const newer: IslandSnapshot = { sessions: [], recentProjects: [], buddyLook: visor, updatedAt: 2 }
    const bare: IslandSnapshot = { sessions: [], recentProjects: [], updatedAt: 3 }
    expect(mergeIslandSnapshots([older, newer, bare]).buddyLook).toEqual(visor)
  })

  test("keeps only the focused window's focused session", () => {
    const background: IslandSnapshot = { sessions: [], recentProjects: [], focusedSessionKey: 'p1:s1', updatedAt: 5 }
    const focused: IslandSnapshot = { sessions: [], recentProjects: [], focusedSessionKey: 'p2:s2', updatedAt: 1 }
    expect(mergeIslandSnapshots([background, focused]).focusedSessionKey).toBeUndefined()
    expect(mergeIslandSnapshots([background, focused], focused).focusedSessionKey).toBe('p2:s2')
  })
})

describe('pendingRequestsToAutoExpand', () => {
  const pending = (id: string) => ({ pending: { kind: 'question', request: { id } } })
  const snap = (focusedSessionKey?: string): IslandSnapshot => ({
    sessions: [session('p1', 's1', pending('r1')), session('p2', 's2', pending('r2'))] as IslandSnapshot['sessions'],
    recentProjects: [],
    ...(focusedSessionKey ? { focusedSessionKey } : {}),
    updatedAt: 1,
  })

  test('suppresses a request in the focused session', () => {
    const decision = pendingRequestsToAutoExpand(snap('p1:s1'), new Set())
    expect(decision.suppressed).toEqual(['r1'])
    expect(decision.expand).toBe('r2')
    expect(pendingRequestsToAutoExpand({ ...snap('p1:s1'), sessions: [snap().sessions[0]] }, new Set())).toEqual({
      expand: null,
      suppressed: ['r1'],
    })
  })

  test('expands for a request in a session that is not focused', () => {
    expect(pendingRequestsToAutoExpand(snap('p3:s3'), new Set())).toEqual({ expand: 'r1', suppressed: [] })
  })

  test('expands when nothing is focused', () => {
    expect(pendingRequestsToAutoExpand(snap(), new Set())).toEqual({ expand: 'r1', suppressed: [] })
  })

  test('ignores requests that were already seen', () => {
    expect(pendingRequestsToAutoExpand(snap(), new Set(['r1', 'r2']))).toEqual({ expand: null, suppressed: [] })
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

  test('validates sound settings', () => {
    expect(parseIslandConfigPatch({ sounds: false, soundVolume: 0.25 })).toEqual({
      ok: true,
      patch: { sounds: false, soundVolume: 0.25 },
    })
    expect(parseIslandConfigPatch({ soundVolume: 2 }).ok).toBe(false)
    expect(parseIslandConfigPatch({ soundVolume: Number.NaN }).ok).toBe(false)
    expect(parseIslandConfigPatch({ sounds: 'on' }).ok).toBe(false)
  })

  test('ignores unknown fields', () => {
    expect(parseIslandConfigPatch({ enabled: true, extra: 1 })).toEqual({ ok: true, patch: { enabled: true } })
  })
})

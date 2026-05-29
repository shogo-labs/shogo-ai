// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  AutoReplyCompileError,
  DEFAULT_COOLDOWN_MS,
  MAX_FIRES_PER_WINDOW,
  RATE_WINDOW_MS,
  WINDOW_BYTES,
  compileMatcher,
  defaultRuleTemplates,
  emptyAutoReplyState,
  evaluateAutoReplies,
  renderReply,
  validateRule,
  type AutoReplyRule,
} from '../auto-replies'

const T0 = 1_000_000

function rule(over: Partial<AutoReplyRule> = {}): AutoReplyRule {
  return {
    id: 'r1',
    label: 'y/N',
    enabled: true,
    match: { kind: 'substring', pattern: '[y/N]' },
    send: { text: 'y', appendNewline: true },
    ...over,
  }
}

describe('compileMatcher', () => {
  test('substring matcher hits on inclusion', () => {
    const m = compileMatcher(rule({ match: { kind: 'substring', pattern: 'hello' } }))
    expect(m('xxx hello xxx')).toBe(true)
    expect(m('hellp')).toBe(false)
  })

  test('regex matcher with flags is case-insensitive when i set', () => {
    const m = compileMatcher(rule({ match: { kind: 'regex', pattern: 'continue', flags: 'i' } }))
    expect(m('Continue connecting')).toBe(true)
    expect(m('CONTINUE')).toBe(true)
    expect(m('done')).toBe(false)
  })

  test('empty substring pattern throws', () => {
    expect(() => compileMatcher(rule({ match: { kind: 'substring', pattern: '' } })))
      .toThrow(AutoReplyCompileError)
  })

  test('invalid regex throws with reason', () => {
    expect(() => compileMatcher(rule({ match: { kind: 'regex', pattern: '(' } })))
      .toThrow(/Invalid regex/)
  })
})

describe('evaluateAutoReplies — basic firing', () => {
  test('fires once when window contains the substring', () => {
    const out = evaluateAutoReplies([rule()], emptyAutoReplyState(), 'Continue? [y/N] ', T0)
    expect(out.fires).toHaveLength(1)
    expect(out.fires[0].ruleId).toBe('r1')
    expect(out.fires[0].send.text).toBe('y')
  })

  test('does not fire on non-matching output', () => {
    const out = evaluateAutoReplies([rule()], emptyAutoReplyState(), 'hello world', T0)
    expect(out.fires).toHaveLength(0)
  })

  test('disabled rule never fires', () => {
    const out = evaluateAutoReplies([rule({ enabled: false })], emptyAutoReplyState(), '[y/N]', T0)
    expect(out.fires).toHaveLength(0)
  })
})

describe('evaluateAutoReplies — cooldown', () => {
  test('cooldown blocks a second match within cooldownMs', () => {
    const r = rule({ cooldownMs: 5_000 })
    const first = evaluateAutoReplies([r], emptyAutoReplyState(), '[y/N]', T0)
    expect(first.fires).toHaveLength(1)
    const second = evaluateAutoReplies([r], first.nextState, '[y/N]', T0 + 100)
    expect(second.fires).toHaveLength(0)
  })

  test('after cooldown elapses, the rule fires again', () => {
    const r = rule({ cooldownMs: 5_000 })
    const first = evaluateAutoReplies([r], emptyAutoReplyState(), '[y/N]', T0)
    const third = evaluateAutoReplies([r], first.nextState, '[y/N]', T0 + 6_000)
    expect(third.fires).toHaveLength(1)
  })

  test('default cooldown is DEFAULT_COOLDOWN_MS when none provided', () => {
    const r = rule({ cooldownMs: undefined })
    const first = evaluateAutoReplies([r], emptyAutoReplyState(), '[y/N]', T0)
    const inside = evaluateAutoReplies([r], first.nextState, '[y/N]', T0 + DEFAULT_COOLDOWN_MS - 1)
    expect(inside.fires).toHaveLength(0)
    const outside = evaluateAutoReplies([r], first.nextState, '[y/N]', T0 + DEFAULT_COOLDOWN_MS + 1)
    expect(outside.fires).toHaveLength(1)
  })
})

describe('evaluateAutoReplies — hard rate limit', () => {
  test('blocks once MAX_FIRES_PER_WINDOW exceeded within RATE_WINDOW_MS', () => {
    const r = rule({ cooldownMs: 0 })
    let state = emptyAutoReplyState()
    for (let i = 0; i < MAX_FIRES_PER_WINDOW; i++) {
      const res = evaluateAutoReplies([r], state, '[y/N]', T0 + i)
      expect(res.fires).toHaveLength(1)
      state = res.nextState
    }
    const blocked = evaluateAutoReplies([r], state, '[y/N]', T0 + MAX_FIRES_PER_WINDOW + 1)
    expect(blocked.fires).toHaveLength(0)
  })

  test('rate limit expires after RATE_WINDOW_MS', () => {
    const r = rule({ cooldownMs: 0 })
    let state = emptyAutoReplyState()
    for (let i = 0; i < MAX_FIRES_PER_WINDOW; i++) {
      const res = evaluateAutoReplies([r], state, '[y/N]', T0 + i)
      state = res.nextState
    }
    const later = evaluateAutoReplies([r], state, '[y/N]', T0 + RATE_WINDOW_MS + 100)
    expect(later.fires).toHaveLength(1)
  })
})

describe('evaluateAutoReplies — sliding window', () => {
  test('match across two chunks succeeds', () => {
    const r = rule({ match: { kind: 'substring', pattern: 'continue?' } })
    const first = evaluateAutoReplies([r], emptyAutoReplyState(), 'Do you want to con', T0)
    expect(first.fires).toHaveLength(0)
    const second = evaluateAutoReplies([r], first.nextState, 'tinue? ', T0 + 10)
    expect(second.fires).toHaveLength(1)
  })

  test('window is trimmed to WINDOW_BYTES', () => {
    const r = rule({ match: { kind: 'substring', pattern: 'needle' } })
    const padding = 'x'.repeat(WINDOW_BYTES)
    const first = evaluateAutoReplies([r], emptyAutoReplyState(), 'needle', T0)
    expect(first.fires).toHaveLength(1)
    expect(first.nextState.window.length).toBeLessThanOrEqual(WINDOW_BYTES)
    // After WINDOW_BYTES of padding, the needle should be gone — no fire on
    // the next bare chunk.
    const flushed = evaluateAutoReplies([r], first.nextState, padding + padding, T0 + 1_000_000)
    expect(flushed.nextState.window.length).toBeLessThanOrEqual(WINDOW_BYTES)
    expect(flushed.nextState.window).not.toContain('needle')
  })
})

describe('evaluateAutoReplies — multiple-rule dedupe', () => {
  test('two rules matching with the same send.text fire once', () => {
    const r1 = rule({ id: 'a' })
    const r2 = rule({ id: 'b' }) // same send.text 'y'
    const out = evaluateAutoReplies([r1, r2], emptyAutoReplyState(), '[y/N]', T0)
    expect(out.fires).toHaveLength(1)
  })

  test('two rules with different send.text both fire', () => {
    const r1 = rule({ id: 'a', send: { text: 'yes', appendNewline: true } })
    const r2 = rule({ id: 'b', send: { text: 'no', appendNewline: true } })
    const out = evaluateAutoReplies([r1, r2], emptyAutoReplyState(), '[y/N]', T0)
    expect(out.fires).toHaveLength(2)
  })
})

describe('evaluateAutoReplies — bad rule isolation', () => {
  test('a rule with a bad regex is silently skipped (not throwing)', () => {
    const bad: AutoReplyRule = rule({ id: 'bad', match: { kind: 'regex', pattern: '(' } })
    const good = rule({ id: 'good' })
    const out = evaluateAutoReplies([bad, good], emptyAutoReplyState(), '[y/N]', T0)
    expect(out.fires).toHaveLength(1)
    expect(out.fires[0].ruleId).toBe('good')
  })
})

describe('renderReply', () => {
  test('appends \\r when appendNewline is true', () => {
    expect(renderReply({ text: 'y', appendNewline: true })).toBe('y\r')
  })
  test('omits \\r when appendNewline is false', () => {
    expect(renderReply({ text: 'y', appendNewline: false })).toBe('y')
  })
})

describe('validateRule', () => {
  test('returns null on a good rule', () => {
    expect(validateRule(rule())).toBeNull()
  })
  test('flags empty id', () => {
    expect(validateRule(rule({ id: '' }))).toMatch(/id/)
  })
  test('flags empty label', () => {
    expect(validateRule(rule({ label: '' }))).toMatch(/label/)
  })
  test('flags empty pattern', () => {
    expect(validateRule(rule({ match: { kind: 'substring', pattern: '' } }))).toMatch(/pattern/)
  })
  test('flags bad regex with the compiler error', () => {
    expect(validateRule(rule({ match: { kind: 'regex', pattern: '(' } }))).toMatch(/Invalid regex/)
  })
})

describe('defaultRuleTemplates', () => {
  test('all templates compile without throwing', () => {
    for (const r of defaultRuleTemplates()) {
      expect(() => compileMatcher(r)).not.toThrow()
    }
  })
  test('all templates start disabled', () => {
    for (const r of defaultRuleTemplates()) {
      expect(r.enabled).toBe(false)
    }
  })
})

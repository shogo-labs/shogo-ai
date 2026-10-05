// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { actionRules, effectiveRule, withActionRule } from '../security-action-rules'

const base = { mode: 'balanced' as const, overrides: { shellCommands: { deny: ['rm *'] } } }

describe('security action rules', () => {
  test('setting a rule keeps the rest of the preferences', () => {
    const next = withActionRule(base, 'github_merge_pr', 'block')
    expect(next.overrides).toEqual({ shellCommands: { deny: ['rm *'] }, actions: { github_merge_pr: 'block' } })
    expect(next.mode).toBe('balanced')
    expect(base.overrides).toEqual({ shellCommands: { deny: ['rm *'] } })
  })
  test('clearing a rule returns the tool to its default', () => {
    const set = withActionRule(base, 'github_merge_pr', 'allow')
    expect(effectiveRule(set, 'github_merge_pr')).toBe('allow')
    const cleared = withActionRule(set, 'github_merge_pr', null)
    expect(actionRules(cleared)).toEqual({})
    expect(effectiveRule(cleared, 'github_merge_pr')).toBe('ask')
    expect(effectiveRule(cleared, 'other_tool')).toBeNull()
  })
  test('ignores unknown rule values and blank tool names', () => {
    expect(actionRules({ overrides: { actions: { a: 'ask', b: 'sometimes' } as any } })).toEqual({ a: 'ask' })
    expect(withActionRule(base, '  ', 'ask')).toBe(base)
  })
})

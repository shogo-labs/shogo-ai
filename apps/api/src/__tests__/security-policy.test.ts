// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { composeCloudPolicy, composeLocalPolicy, mergeActions, normalizeActions } from '../lib/security-policy'

const decode = (s: string | null) => JSON.parse(Buffer.from(s!, 'base64').toString())

describe('action rule merging', () => {
  test('keeps only valid rules', () => {
    expect(normalizeActions({ a: 'ask', b: 'nope', c: 3, '': 'block' })).toEqual({ a: 'ask' })
    expect(normalizeActions(['ask'])).toEqual({})
    expect(normalizeActions(null)).toEqual({})
  })
  test('stricter rule wins, unions the rest', () => {
    expect(mergeActions({ merge: 'ask', exec: 'block' }, { merge: 'block', exec: 'allow', web: 'ask' })).toEqual({ merge: 'block', exec: 'block', web: 'ask' })
  })
})

describe('local policy', () => {
  const user = { mode: 'balanced', approvalTimeoutSeconds: 60, overrides: { shellCommands: { deny: ['rm *'] }, actions: { a: 'ask' } } }
  test('without a project override the user preference is untouched', () => {
    expect(composeLocalPolicy(user, undefined)).toEqual(user)
  })
  test('project mode can lower but not raise the mode; shell denies union', () => {
    const lower = composeLocalPolicy(user, { mode: 'strict', overrides: { shellCommands: { deny: ['gh pr merge*'] } } })
    expect(lower.mode).toBe('strict')
    expect(lower.overrides.shellCommands.deny).toEqual(['rm *', 'gh pr merge*'])
    expect(composeLocalPolicy(user, { mode: 'full_autonomy' }).mode).toBe('balanced')
  })
  test('project action rules apply even when it sets no mode', () => {
    const out = composeLocalPolicy(user, { overrides: { actions: { a: 'block', github_merge_pr: 'ask' } } })
    expect(out.mode).toBe('balanced')
    expect(out.overrides.actions).toEqual({ a: 'block', github_merge_pr: 'ask' })
    expect(out.overrides.shellCommands.deny).toEqual(['rm *'])
  })
})

describe('cloud policy', () => {
  test('null when nothing is configured', () => {
    expect(composeCloudPolicy(undefined)).toBeNull()
    expect(composeCloudPolicy({ mode: 'strict' })).toBeNull()
  })
  test('carries action rules and deny lists with a long approval timeout', () => {
    const p = decode(composeCloudPolicy({ overrides: { actions: { github_merge_pr: 'ask', bad: 'x' }, shellCommands: { deny: ['*gh pr merge*'] } } }))
    expect(p).toEqual({
      mode: 'full_autonomy',
      approvalTimeoutSeconds: 900,
      overrides: { actions: { github_merge_pr: 'ask' }, shellCommands: { deny: ['*gh pr merge*'] } },
    })
  })
})

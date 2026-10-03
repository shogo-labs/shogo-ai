// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-tool action rules: allow, ask a person first, or block, checked before
 * mode defaults. Cloud runtimes enforce only these rules.
 *
 *   bun test packages/agent-runtime/src/__tests__/permission-action-rules.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@shogo/shared-runtime', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const {
  PermissionEngine,
  DEFAULT_ACTION_RULES,
  DEFAULT_CLOUD_SECURITY_PREFERENCE,
  mergeActionRules,
  mergePolicy,
  normalizeActionRules,
  parseSecurityPolicy,
  encodeSecurityPolicy,
  isPermissionGated,
  withActionRules,
  withPermissionGate,
} = await import('../permission-engine')

let workspaceDir: string
beforeEach(() => {
  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'shogo-actions-')))
})
afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }))

function engine(preference: any, extra: Record<string, unknown> = {}) {
  return new PermissionEngine({ preference, workspaceDir, ...extra })
}

function tool(name: string) {
  const calls: any[] = []
  return {
    calls,
    tool: {
      name,
      label: name,
      description: name,
      parameters: {} as any,
      execute: async (_id: string, params: any) => {
        calls.push(params)
        return { content: [{ type: 'text', text: 'ran' }], details: { ran: true } }
      },
    } as any,
  }
}

describe('rules', () => {
  test('merging a pull request asks by default; other tools have no rule', () => {
    expect(DEFAULT_ACTION_RULES.github_merge_pr).toBe('ask')
    const e = engine({ mode: 'full_autonomy' })
    expect(e.actionRuleFor('github_merge_pr')).toBe('ask')
    expect(e.actionRuleFor('github_create_pr')).toBeUndefined()
  })

  test('configured rules win over the default, and unknown values are ignored', () => {
    const e = engine({ mode: 'full_autonomy', overrides: { actions: { github_merge_pr: 'allow', send_message: 'block', exec: 'maybe' as any } } })
    expect(e.actionRuleFor('github_merge_pr')).toBe('allow')
    expect(e.actionRuleFor('send_message')).toBe('block')
    expect(normalizeActionRules({ a: 'allow', b: 'nope', c: 3, '': 'ask' })).toEqual({ a: 'allow' })
    expect(normalizeActionRules(['ask'])).toEqual({})
  })

  test('block denies, ask asks, allow runs, in every mode — and a rule beats the mode default', () => {
    for (const mode of ['strict', 'balanced', 'full_autonomy'] as const) {
      const e = engine({ mode, overrides: { actions: { a: 'block', b: 'ask', c: 'allow' } } })
      expect(e.check('project', 'a', {}).action).toBe('deny')
      expect(e.check('project', 'b', {}).action).toBe('ask')
      expect(e.check('project', 'c', {}).action).toBe('allow')
    }
    // strict mode would ask for a shell tool; an allow rule lets it through
    expect(engine({ mode: 'strict', overrides: { actions: { exec: 'allow' } } }).check('shell', 'exec', { command: 'ls' }).action).toBe('allow')
  })

  test('hard blocks and deny lists still win over an allow rule', () => {
    const e = engine({ mode: 'full_autonomy', overrides: { actions: { exec: 'allow' }, shellCommands: { deny: ['gh pr merge*'] } } })
    expect(e.check('shell', 'exec', { command: 'sudo ls' }).action).toBe('deny')
    expect(e.check('shell', 'exec', { command: 'gh pr merge 12' }).action).toBe('deny')
    expect(e.check('shell', 'exec', { command: 'ls' }).action).toBe('allow')
  })

  test('merging rules keeps the stricter one; a project cannot loosen the user', () => {
    expect(mergeActionRules({ a: 'allow', b: 'block' }, { a: 'ask', b: 'allow', c: 'block' })).toEqual({ a: 'ask', b: 'block', c: 'block' })
    const merged = mergePolicy(
      { mode: 'balanced', overrides: { actions: { github_merge_pr: 'ask', x: 'block' } } },
      { mode: 'balanced', overrides: { actions: { github_merge_pr: 'allow', y: 'ask' } } },
    )
    expect(merged.overrides?.actions).toEqual({ github_merge_pr: 'ask', x: 'block', y: 'ask' })
  })

  test('contains-patterns catch a command inside a longer one', () => {
    const e = engine({ mode: 'full_autonomy', overrides: { shellCommands: { deny: ['*gh pr merge*'] } } })
    expect(e.check('shell', 'exec', { command: 'cd repo && gh pr merge 3 --squash' }).action).toBe('deny')
    expect(e.check('shell', 'exec', { command: 'gh pr view 3' }).action).toBe('allow')
  })
})

describe('persistence', () => {
  test('rules in .shogo/permissions.json merge in, stricter wins, and survive persistRules()', () => {
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo', 'permissions.json'), JSON.stringify({ actions: { a: 'block', b: 'allow' } }))
    const e = engine({ mode: 'balanced', overrides: { actions: { a: 'ask', b: 'ask' } } })
    expect(e.getOverrides()?.actions).toEqual({ a: 'block', b: 'ask' })
    e.persistRules()
    expect(JSON.parse(readFileSync(join(workspaceDir, '.shogo', 'permissions.json'), 'utf-8')).actions).toEqual({ a: 'block', b: 'ask' })
  })

  test('rules written into the workspace after startup apply from the next turn', () => {
    const e = engine({ mode: 'full_autonomy' })
    expect(e.check('network', 'github_merge_pr', {}).action).toBe('ask')
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo', 'permissions.json'), JSON.stringify({ actions: { github_merge_pr: 'block' } }))
    expect(e.check('network', 'github_merge_pr', {}).action).toBe('ask')
    e.resetTurn()
    expect(e.check('network', 'github_merge_pr', {}).action).toBe('deny')
  })

  test('the policy env round-trips actions, and cloud defaults give people time to answer', () => {
    const pref = parseSecurityPolicy(encodeSecurityPolicy({ mode: 'full_autonomy', overrides: { actions: { github_merge_pr: 'block' } } }))
    expect(pref.overrides?.actions).toEqual({ github_merge_pr: 'block' })
    expect(parseSecurityPolicy(undefined, DEFAULT_CLOUD_SECURITY_PREFERENCE).approvalTimeoutSeconds).toBe(900)
    expect(parseSecurityPolicy(encodeSecurityPolicy({ mode: 'full_autonomy', approvalTimeoutSeconds: 60 }), DEFAULT_CLOUD_SECURITY_PREFERENCE).approvalTimeoutSeconds).toBe(60)
  })
})

describe('cloud (actions only)', () => {
  const cloud = (overrides?: any) => engine({ ...DEFAULT_CLOUD_SECURITY_PREFERENCE, overrides }, { actionsOnly: true })

  test('only rules and deny lists apply; mode defaults and built-in blocks do not', () => {
    const e = cloud({ actions: { send_message: 'block' } })
    expect(e.isActionsOnly).toBe(true)
    expect(e.check('shell', 'exec', { command: 'sudo ls' }).action).toBe('allow')
    expect(e.check('system', 'anything', {}).action).toBe('allow')
    expect(e.check('project', 'github_merge_pr', {}).action).toBe('ask')
    expect(e.check('project', 'send_message', {}).action).toBe('deny')
    const withDeny = cloud({ shellCommands: { deny: ['*gh pr merge*'] } })
    expect(withDeny.check('shell', 'exec', { command: 'gh pr merge 4' }).action).toBe('deny')
    expect(withDeny.check('shell', 'exec', { command: 'git push' }).action).toBe('allow')
  })
})

describe('gating tools', () => {
  test('a blocked tool never runs and tells the agent not to ask again', async () => {
    const t = tool('send_message')
    const gated = withActionRules(t.tool, engine({ mode: 'full_autonomy', overrides: { actions: { send_message: 'block' } } }))
    const res = await gated.execute('c1', { text: 'hi' })
    expect(t.calls).toHaveLength(0)
    expect((res.details as any).error).toContain('never run')
    expect((res.details as any).instruction).toContain('Do NOT ask')
  })

  test('an ask rule waits for a person: approval runs the tool once, a denial does not', async () => {
    const events: any[] = []
    const e = engine({ mode: 'full_autonomy', approvalTimeoutSeconds: 5 }, { actionsOnly: true, sendSseEvent: (ev: any) => events.push(ev) })
    const t = tool('github_merge_pr')
    const gated = withActionRules(t.tool, e)

    const first = gated.execute('c1', { number: 12 })
    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('data-permission-request')
    expect(events[0].data).toMatchObject({ toolName: 'github_merge_pr', params: { number: 12 } })
    expect(t.calls).toHaveLength(0)
    e.handleApprovalResponse({ id: events[0].data.id, decision: 'allow_once' })
    await first
    expect(t.calls).toEqual([{ number: 12 }])

    e.resetTurn()
    const second = gated.execute('c2', { number: 13 })
    await Promise.resolve()
    e.handleApprovalResponse({ id: events[1].data.id, decision: 'deny' })
    const res = await second
    expect(t.calls).toHaveLength(1)
    expect((res.details as any).error).toContain('declined')
  })

  test('the first answer wins; a late second answer is ignored', async () => {
    const events: any[] = []
    const e = engine({ mode: 'full_autonomy', approvalTimeoutSeconds: 5 }, { actionsOnly: true, sendSseEvent: (ev: any) => events.push(ev) })
    const t = tool('github_merge_pr')
    const run = withActionRules(t.tool, e).execute('c1', { number: 1 })
    await Promise.resolve()
    const id = events[0].data.id
    e.handleApprovalResponse({ id, decision: 'deny' })
    e.handleApprovalResponse({ id, decision: 'allow_once' })
    await run
    expect(t.calls).toHaveLength(0)
  })

  test('with nobody to ask (no connected client) an ask rule fails closed', async () => {
    const e = engine({ mode: 'full_autonomy' }, { actionsOnly: true })
    const t = tool('github_merge_pr')
    const res = await withActionRules(t.tool, e).execute('c1', { number: 1 })
    expect(t.calls).toHaveLength(0)
    expect((res.details as any).error).toContain('declined')
  })

  test('tools without a rule run untouched, and already gated tools are not wrapped twice', async () => {
    const e = engine({ mode: 'strict' })
    const plain = tool('read_thing')
    const ungated = withActionRules(plain.tool, e)
    await ungated.execute('c1', {})
    expect(plain.calls).toHaveLength(1)

    const gated = withPermissionGate(tool('exec').tool, 'file_read', e)
    expect(isPermissionGated(gated)).toBe(true)
    expect(withActionRules(gated, e)).toBe(gated)
    expect(isPermissionGated(ungated)).toBe(true)
  })

  test('an action rule applies to a tool that has a category too', async () => {
    const e = engine({ mode: 'full_autonomy', overrides: { actions: { write_file: 'block' } } })
    const t = tool('write_file')
    const res = await withPermissionGate(t.tool, 'file_write', e).execute('c1', { path: 'a.txt' })
    expect(t.calls).toHaveLength(0)
    expect((res.details as any).error).toContain('never run')
  })
})

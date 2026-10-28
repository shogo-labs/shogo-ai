// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-221 — a Personal workspace does not build apps.
//
// The companion used to be told to `project_create` + `project_call` a hidden
// builder project. That path never produced a working preview for Alan
// (alan@mari-os.com), and it is what Russell asked to reverse: the agent knows
// it is personal, says it doesn't build here, and points at the Team workspace.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway, PERSONAL_COMPANION_GUIDE, type GatewayConfig } from '../gateway'
import { parseAccountContext } from '../account-context'

const ROOT = '/tmp/test-sho-221-personal-no-build'

function makeWs(name: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\npersonal\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    heartbeatToolsEnabled: true,
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    ...overrides,
  } as GatewayConfig
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

describe('PERSONAL_COMPANION_GUIDE', () => {
  test('says building happens in the Team workspace, and how to get there', () => {
    expect(PERSONAL_COMPANION_GUIDE).toContain('Team workspace')
    expect(PERSONAL_COMPANION_GUIDE).toMatch(/workspace switcher/)
    expect(PERSONAL_COMPANION_GUIDE).toMatch(/don't build/i)
  })

  test('overrides the delegation steps older workspaces still carry on disk', () => {
    expect(PERSONAL_COMPANION_GUIDE).toMatch(/overrides any older instruction/i)
    expect(PERSONAL_COMPANION_GUIDE).toContain('AGENTS.md')
    expect(PERSONAL_COMPANION_GUIDE).toContain('HEARTBEAT.md')
  })

  test('no longer tells the agent to create or call a builder project', () => {
    expect(PERSONAL_COMPANION_GUIDE).not.toContain('project_create')
    expect(PERSONAL_COMPANION_GUIDE).not.toContain('project_call')
  })
})

describe('prompt wiring', () => {
  test('a personal turn gets the guide, a team turn does not', () => {
    const ws = makeWs('prompt')
    const gw = new AgentGateway(ws, 'p1')

    const personal: string = (gw as any).loadBootstrapContext(undefined, makeConfig({ capabilityProfile: 'personal' }))
    expect(personal).toContain('## Personal Companion Mode')
    expect(personal).toMatch(/building happens in their \*\*Team workspace\*\*/)

    const team: string = (gw as any).loadBootstrapContext(undefined, makeConfig({ capabilityProfile: 'team' }))
    expect(team).not.toContain('## Personal Companion Mode')
  })

  test('the general prompt profile carries the same guide for personal only', () => {
    const ws = makeWs('general-prompt')
    const gw = new AgentGateway(ws, 'p1')

    const personal: string = (gw as any).buildGeneralPrompt(undefined, makeConfig({ capabilityProfile: 'personal' }))
    expect(personal).toContain('## Personal Companion Mode')
    expect(personal).not.toContain('project_create')

    const team: string = (gw as any).buildGeneralPrompt(undefined, makeConfig({ capabilityProfile: 'team' }))
    expect(team).not.toContain('## Personal Companion Mode')
  })
})

// The stamp on the request only reaches the prompt if the gateway keeps it:
// `setAccountContext` rebuilds the whole object per request, so a field it
// doesn't copy is silently dead in production (QA round 1 on SHO-221).
describe('account context survives into the prompt', () => {
  test("a personal turn names the caller's Team workspace", () => {
    const ws = makeWs('account-context-names')
    const gw = new AgentGateway(ws, 'p1')
    gw.setAccountContext(parseAccountContext({ teamWorkspaceNames: ['Acme', 'Side project'] }))

    const personal: string = (gw as any).loadBootstrapContext(undefined, makeConfig({ capabilityProfile: 'personal' }))
    expect(personal).toContain('**Acme**')
    expect(personal).toContain('**Side project**')
  })

  test('no Team workspace yet falls back to how to create one', () => {
    const ws = makeWs('account-context-empty')
    const gw = new AgentGateway(ws, 'p1')
    gw.setAccountContext(parseAccountContext({ teamWorkspaceNames: [] }))

    const personal: string = (gw as any).loadBootstrapContext(undefined, makeConfig({ capabilityProfile: 'personal' }))
    expect(personal).toContain('no Team workspace yet')
  })

  test('a request without the field clears the names, so a Team chat never sees them', () => {
    const ws = makeWs('account-context-cleared')
    const gw = new AgentGateway(ws, 'p1')
    gw.setAccountContext(parseAccountContext({ teamWorkspaceNames: ['Acme'] }))
    gw.setAccountContext(parseAccountContext({ planId: 'pro' }))

    const team: string = (gw as any).loadBootstrapContext(undefined, makeConfig({ capabilityProfile: 'team' }))
    expect(team).not.toContain('**Acme**')
    expect(team).not.toContain('no Team workspace yet')
  })
})

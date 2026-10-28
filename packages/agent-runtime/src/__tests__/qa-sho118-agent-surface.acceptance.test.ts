// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-118, criterion 5: "an agent woken while paused sees
 * 'workspace paused' and stops instead of starting work".
 *
 * The dev's `chat-handoff-tool.test.ts` and `concurrent-chats-prompt.test.ts`
 * cover bug 1 (the argument names) and the reachability labels. Nothing covered
 * the paused section or the fact that it is actually wired into the prompt a
 * turn runs on, so this drives the gateway's own prompt builders — the same
 * seam `gateway.prompt-builders.test.ts` uses.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { CHANNEL_TOOL_NAMES, createAgentRunStopTool, createAgentRunsListTool } from '../channel-tools'

const ROOT = '/tmp/test-gw-sho118-paused'

function makeWs(name: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(
    join(ws, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nQA fixture\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

const PAUSE = {
  at: '2026-10-21T07:19:00.000Z',
  by: 'user-1',
  reason: 'stop every lane',
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

function gateway(name: string, sessionId = 'sess-1'): { gw: any; prompt: (profile?: string) => string } {
  const gw: any = new AgentGateway(makeWs(name), 'p1')
  return {
    gw,
    prompt: (profile?: string) =>
      gw.loadBootstrapContext(sessionId, profile ? { ...gw.config, promptProfile: profile } : undefined) as string,
  }
}

describe('the paused section', () => {
  test('is absent when no pause is in force — a pause costs no prompt bytes', () => {
    const { gw, prompt } = gateway('no-pause')
    expect(gw.buildWorkspacePausedContext('sess-1')).toBeNull()
    expect(prompt()).not.toContain('Workspace paused')
  })

  test('names the pause, who set it and why, and tells the agent to stop', () => {
    const { gw } = gateway('with-pause')
    gw.turnPause.set('sess-1', PAUSE)
    const section = gw.buildWorkspacePausedContext('sess-1') as string
    expect(section).toContain('## Workspace paused (agent lanes)')
    expect(section).toContain('2026-10-21T07:19:00.000Z')
    expect(section).toContain('by user-1')
    expect(section).toContain('Reason: stop every lane')
    // The instruction a woken agent has to follow instead of starting work.
    expect(section).toMatch(/Do not start new work/)
    expect(section).toMatch(/report what you stopped and stop/)
    // The lifting call is named, so it is not guessed at.
    expect(section).toContain('agent_run_stop({ scope: "workspace", resume: true })')
  })

  test('one paused session does not leak into another session’s prompt', () => {
    const { gw, prompt } = gateway('scoped')
    gw.turnPause.set('other-session', PAUSE)
    expect(prompt()).not.toContain('Workspace paused')
    expect(gw.buildWorkspacePausedContext('sess-1')).toBeNull()
  })

  test('reaches the prompt the turn actually runs on, on every profile', () => {
    const { gw, prompt } = gateway('wired')
    gw.turnPause.set('sess-1', PAUSE)
    // default (the production profile), general and swe each push the section.
    for (const profile of [undefined, 'general', 'swe']) {
      const text = prompt(profile)
      expect(text.length).toBeGreaterThan(100)
      expect(text).toContain('## Workspace paused (agent lanes)')
      expect(text).toContain('Reason: stop every lane')
    }
  })

  test('a pause with no reason and no actor still renders a usable section', () => {
    const { gw } = gateway('bare-pause')
    gw.turnPause.set('sess-1', { at: '2026-10-21T07:19:00.000Z', by: null })
    const section = gw.buildWorkspacePausedContext('sess-1') as string
    expect(section).toContain('## Workspace paused (agent lanes)')
    expect(section).not.toContain('Reason:')
    expect(section).not.toContain(' by null')
  })
})

describe('the agent surface did not grow a tool', () => {
  test('the pause is a scope on agent_run_stop, not a new tool', () => {
    // Russell's rule: a new agent-facing tool needs an explicit yes. SHO-118
    // had to extend the one it had.
    expect(CHANNEL_TOOL_NAMES as readonly string[]).not.toContain('workspace_pause')
    expect(CHANNEL_TOOL_NAMES.filter((name) => /pause/i.test(name))).toEqual([])

    const ctx: any = { sessionId: 'sess-1', workspaceId: 'ws-1' }
    const stop: any = createAgentRunStopTool(ctx)
    const props = stop.parameters.properties as Record<string, unknown>
    expect(Object.keys(props)).toContain('scope')
    expect(Object.keys(props)).toContain('resume')
    expect(stop.description).toContain('scope "workspace"')
    expect(stop.description).toContain('resume: true')
    // `agent_runs_list` reports the pause rather than a second read tool.
    const list: any = createAgentRunsListTool(ctx)
    expect(list.name).toBe('agent_runs_list')
  })
})

describe('reading the pause for a turn fails open', () => {
  test('with no workspace identity the turn is primed with nothing and renders no section', async () => {
    const saved = { WORKSPACE_ID: process.env.WORKSPACE_ID, RUNTIME_AUTH_SECRET: process.env.RUNTIME_AUTH_SECRET }
    delete process.env.WORKSPACE_ID
    delete process.env.RUNTIME_AUTH_SECRET
    try {
      const { gw, prompt } = gateway('fail-open')
      await gw.primeTurnFacts('sess-1')
      expect(gw.turnPause.size).toBe(0)
      expect(gw.turnReachable.size).toBe(0)
      expect(prompt()).not.toContain('Workspace paused')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

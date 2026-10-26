// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One mode: every turn is an agent turn (SHO-214).
 *
 * The Plan / Agent / Ask selector is gone, so a request body that still carries
 * `interactionMode` — an older desktop build, a cached web bundle, a message
 * already sitting in the chat queue — must be treated as what it is: an unknown
 * field. The turn gets the full agent tool set and a system prompt with no
 * plan/ask block. Nothing narrows the tools except coordinator mode, which is
 * server config rather than something a person picks.
 *
 * The body is handed to the gateway the way `/agent/chat` hands it over, so a
 * stale field would reach `processChatMessageStream` if the route still read it.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse } from '../pi-adapter'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

let testCounter = 0
const makeTestDir = () => join(tmpdir(), `test-one-mode-${process.pid}-${++testCounter}`)

function setupWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

/** Records the exact context (system prompt + advertised tools) each model call saw. */
function capturingStream(contexts: any[]): StreamFn {
  return (_model, context) => {
    contexts.push(context)
    const response = buildTextResponse('Done.')
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: response })
      stream.push({ type: 'done', reason: 'stop', message: response })
      stream.end(response)
    })
    return stream as any
  }
}

describe('one mode: a stale interactionMode field changes nothing (SHO-214)', () => {
  let gateway: AgentGateway
  let testDir: string
  const previous = { plan: process.env.AGENT_MAX_PLAN_CONTINUATIONS, auto: process.env.AGENT_MAX_AUTO_CONTINUATIONS }

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
    trustWorkspaceForTests(testDir)
    // One model call per turn, so each capture is the turn under test.
    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '0'
    process.env.AGENT_MAX_AUTO_CONTINUATIONS = '0'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    clearTrustForTests()
    rmSync(testDir, { recursive: true, force: true })
    for (const [key, value] of [
      ['AGENT_MAX_PLAN_CONTINUATIONS', previous.plan],
      ['AGENT_MAX_AUTO_CONTINUATIONS', previous.auto],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  for (const mode of ['plan', 'ask'] as const) {
    test(`an old "${mode}" body still runs a full agent turn`, async () => {
      const contexts: any[] = []
      gateway = new AgentGateway(testDir, 'test-project')
      gateway.setStreamFn(capturingStream(contexts))
      await gateway.start()

      const body: Record<string, unknown> = {
        interactionMode: mode,
        chatSessionId: `stale-${mode}`,
      }
      await gateway.processChatMessageStream(
        'Add a health endpoint',
        { write: () => {} } as any,
        body as any,
      )

      expect(contexts).toHaveLength(1)
      const toolNames: string[] = (contexts[0].tools ?? []).map((tool: any) => tool.name)
      // The core edit/exec tools are the whole point of "always agent mode".
      for (const name of ['read_file', 'write_file', 'edit_file', 'exec']) {
        expect(toolNames).toContain(name)
      }

      const systemPrompt: string = contexts[0].systemPrompt ?? ''
      expect(systemPrompt).not.toContain('PLAN MODE ACTIVE')
      expect(systemPrompt).not.toContain('ASK MODE ACTIVE')
    })
  }

  test('the tool set is identical with and without the field', async () => {
    const contexts: any[] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(capturingStream(contexts))
    await gateway.start()

    await gateway.processChatMessageStream('Hello', { write: () => {} } as any, {
      chatSessionId: 'with-field',
      interactionMode: 'plan',
    } as any)
    await gateway.processChatMessageStream('Hello', { write: () => {} } as any, {
      chatSessionId: 'without-field',
    })

    const names = (contexts[0].tools ?? []).map((tool: any) => tool.name).sort()
    expect((contexts[1].tools ?? []).map((tool: any) => tool.name).sort()).toEqual(names)
    expect(names).toContain('exec')
  })
})

/**
 * `agentTurn` is positional, so dropping its `interactionMode` parameter shifted
 * every argument after it. A caller that still passed a mode string handed the
 * truthy `'agent'` to `dualPlan`, `false` to `requesterTicket` and the ticket to
 * `chatContext`. `processPipelineCall` (the `project_call` path) was the last
 * caller doing that; this pins the order so the next signature change shows up
 * here instead of on a live project call.
 */
describe('processPipelineCall passes the agent-turn arguments in order (SHO-214)', () => {
  test('dualPlan is false, the requester ticket is the ticket, chatContext is unset', async () => {
    const dir = makeTestDir()
    setupWorkspace(dir)
    const gateway = new AgentGateway(dir, 'test-project')
    let seen: unknown[] = []
    ;(gateway as any).agentTurn = (...args: unknown[]) => {
      seen = args
      return Promise.resolve('ok')
    }
    try {
      const result = await gateway.processPipelineCall({
        message: 'Do the thing',
        runId: 'run-1',
        requesterTicket: 'ticket-1',
      })

      expect(result).toEqual({ reply: 'ok', sessionId: 'run:run-1', runId: 'run-1' })
      expect(seen).toHaveLength(9)
      expect(seen[7]).toBe(false)
      expect(seen[8]).toBe('ticket-1')
      expect(seen[9]).toBeUndefined()
    } finally {
      await gateway.stop().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

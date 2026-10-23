// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A turn that ends while its own todo list still has open items must keep
 * going, instead of stopping on a status report and waiting for the user to
 * type "continue" (SHO-121).
 *
 * The model is canned (`setStreamFn`) — no provider call, no cost.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse, buildToolUseResponse } from '../pi-adapter'
import { clearSessionTodos } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

let testCounter = 0
const makeTestDir = () => join(tmpdir(), `test-plan-continuation-${process.pid}-${++testCounter}`)

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

const todo = (id: string, content: string, status: 'pending' | 'in_progress' | 'completed') => ({ id, content, status })

/** Serves the responses in order; the last one repeats if the turn keeps going. */
function cannedStream(responses: AssistantMessage[], calls: Message[][] = []): StreamFn {
  let index = 0
  return (_model, context) => {
    calls.push([...context.messages])
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    const stream = createAssistantMessageEventStream()
    const reason = response.content.some((c: any) => c.type === 'toolCall') ? 'toolUse' : 'stop'
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: response })
      stream.push({ type: 'done', reason, message: response })
      stream.end(response)
    })
    return stream as any
  }
}

const collectingWriter = () => {
  const chunks: any[] = []
  return { writer: { write: (chunk: any) => { chunks.push(chunk) } }, chunks }
}

const userTexts = (messages: Message[]): string[] =>
  messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as any[]).filter((block) => block.type === 'text').map((block) => block.text).join(''),
    )


describe('plan continuation (SHO-121)', () => {
  let gateway: AgentGateway
  let testDir: string
  const previous = { plan: process.env.AGENT_MAX_PLAN_CONTINUATIONS, auto: process.env.AGENT_MAX_AUTO_CONTINUATIONS }

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
    trustWorkspaceForTests(testDir)
    delete process.env.AGENT_MAX_PLAN_CONTINUATIONS
    // An empty-turn retry (a second loop for the *same* prompt) would blur the
    // call count this suite asserts on.
    process.env.AGENT_MAX_AUTO_CONTINUATIONS = '0'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    clearTrustForTests()
    clearSessionTodos('plan-continues')
    rmSync(testDir, { recursive: true, force: true })
    for (const [key, value] of [
      ['AGENT_MAX_PLAN_CONTINUATIONS', previous.plan],
      ['AGENT_MAX_AUTO_CONTINUATIONS', previous.auto],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('keeps going while items it wrote this turn are still open', async () => {
    const calls: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            {
              name: 'todo_write',
              id: 'tu_todo_1',
              arguments: {
                todos: [todo('1', 'Read the repo', 'completed'), todo('2', 'Write the endpoint', 'in_progress'), todo('3', 'Add tests', 'pending')],
              },
            },
          ]),
          buildTextResponse('Status: 1 of 3 done — the endpoint is next.'),
          buildToolUseResponse([
            {
              name: 'todo_write',
              id: 'tu_todo_2',
              arguments: {
                todos: [todo('1', 'Read the repo', 'completed'), todo('2', 'Write the endpoint', 'completed'), todo('3', 'Add tests', 'completed')],
              },
            },
          ]),
          buildTextResponse('All three are done: endpoint written and tested.'),
        ],
        calls,
      ),
    )
    await gateway.start()

    const { writer } = collectingWriter()
    await gateway.processChatMessageStream('Finish the endpoint and its tests', writer as any, {
      chatSessionId: 'plan-continues',
    })

    // 2 model calls in the first loop + 2 in the continuation pass.
    expect(calls).toHaveLength(4)
    // The continuation was a synthetic user message, not a person's reply.
    const continuationPrompt = userTexts(calls[2]!).find((text) => text.startsWith('Keep working'))
    expect(continuationPrompt).toContain('- Write the endpoint')
    expect(continuationPrompt).toContain('- Add tests')
    expect(continuationPrompt).toContain('Do not post a status report')
    // Nothing was asked of the person: the only user messages in the turn's
    // history are the original prompt and our own continuation.
    expect(userTexts(calls[3]!).filter((text) => text.trim())).toHaveLength(2)

    // The turn ends on the finished work, not on the halfway status report.
    const stored = gateway.getSessionManager().get('plan-continues')!
    const assistantTexts = stored.messages
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content as any[]).filter((block) => block.type === 'text').map((block) => block.text).join(''),
      )
    expect(assistantTexts.at(-1)).toContain('All three are done')
  })

  test('does not continue when the list is complete', async () => {
    const calls: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            {
              name: 'todo_write',
              id: 'tu_done',
              arguments: { todos: [todo('1', 'Only step', 'completed')] },
            },
          ]),
          buildTextResponse('Done — the only step is complete.'),
        ],
        calls,
      ),
    )
    await gateway.start()

    const { writer } = collectingWriter()
    await gateway.processChatMessageStream('Do the one thing', writer as any, { chatSessionId: 'plan-continues' })
    expect(calls).toHaveLength(2)
  })

  test('does not continue on a list written by an earlier turn', async () => {
    // Turn 1 writes an unfinished list while the loop is disabled, which is
    // exactly the stale state a later turn must not restart.
    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '0'
    gateway = new AgentGateway(testDir, 'test-project')
    const firstCalls: Message[][] = []
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            { name: 'todo_write', id: 'tu_stale', arguments: { todos: [todo('1', 'Left over', 'pending')] } },
          ]),
          buildTextResponse('Noted; I will start here.'),
        ],
        firstCalls,
      ),
    )
    await gateway.start()
    const first = collectingWriter()
    await gateway.processChatMessageStream('Look at the plan', first.writer as any, { chatSessionId: 'plan-continues' })
    expect(firstCalls).toHaveLength(2)

    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '2'
    const secondCalls: Message[][] = []
    gateway.setStreamFn(cannedStream([buildTextResponse('Unrelated answer.')], secondCalls))
    const second = collectingWriter()
    await gateway.processChatMessageStream('What is the weather?', second.writer as any, { chatSessionId: 'plan-continues' })
    expect(secondCalls).toHaveLength(1)
  })

  test('does not continue after a question to the user', async () => {
    const calls: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            {
              name: 'todo_write',
              id: 'tu_ask_todo',
              arguments: { todos: [todo('1', 'Deploy it', 'pending')] },
            },
          ]),
          buildToolUseResponse([
            {
              name: 'ask_user',
              id: 'tu_ask',
              arguments: {
                questions: [
                  {
                    header: 'Region',
                    question: 'Which region should I deploy to?',
                    options: [{ label: 'us-east', description: 'Virginia' }],
                  },
                ],
              },
            },
          ]),
          buildTextResponse('Which region should I deploy to?'),
        ],
        calls,
      ),
    )
    await gateway.start()

    const { writer } = collectingWriter()
    await gateway.processChatMessageStream('Deploy it', writer as any, { chatSessionId: 'plan-continues' })
    expect(calls).toHaveLength(3)
  })

  test('AGENT_MAX_PLAN_CONTINUATIONS=0 disables the loop', async () => {
    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '0'
    const calls: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            { name: 'todo_write', id: 'tu_off', arguments: { todos: [todo('1', 'Still open', 'pending')] } },
          ]),
          buildTextResponse('Where I got to.'),
        ],
        calls,
      ),
    )
    await gateway.start()

    const { writer } = collectingWriter()
    await gateway.processChatMessageStream('Start the work', writer as any, { chatSessionId: 'plan-continues' })
    expect(calls).toHaveLength(2)
  })

  test('stops after one pass when the continuation makes no tool call', async () => {
    const calls: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      cannedStream(
        [
          buildToolUseResponse([
            { name: 'todo_write', id: 'tu_blocked', arguments: { todos: [todo('1', 'Needs the API key', 'in_progress')] } },
          ]),
          buildTextResponse('I wrote the first half.'),
          // Every further pass says it is blocked, with no tool call.
          buildTextResponse('I am blocked on the API key you need to provide.'),
        ],
        calls,
      ),
    )
    await gateway.start()

    const { writer } = collectingWriter()
    await gateway.processChatMessageStream('Do the integration', writer as any, { chatSessionId: 'plan-continues' })
    // 2 calls first pass + exactly 1 continuation pass, not the full budget.
    expect(calls).toHaveLength(3)
  })
})

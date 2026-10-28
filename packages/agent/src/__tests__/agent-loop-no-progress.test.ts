// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (SHO-235): the no-progress breaker was evaluated per tool call,
 * inside `tool_execution_end`. One model turn that fired five calls in parallel
 * therefore filled the five-call window by itself, and the turn was aborted
 * before the model saw a single error — the model made one mistake and was
 * killed for it.
 *
 * These tests drive the real `runAgentLoop` with a scripted model: the batch of
 * failures must reach the model and the turn must continue, while five turns of
 * genuine thrash must still stop.
 */
import { describe, test, expect } from 'bun:test'
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function fakeModel(): Model<Api> {
  return {
    id: 'fake', name: 'fake', api: 'openai-completions', provider: 'openai',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 100,
  } as Model<Api>
}

type Step =
  | { calls: Array<{ name: string; arguments: Record<string, any> }> }
  | { text: string }

/** Plays the scripted turns back in order, whatever the loop asks for. */
function scriptedStream(steps: Step[]): StreamFn {
  let turn = 0
  return ((_model: Model<Api>) => {
    const stream = createAssistantMessageEventStream()
    const step = steps[Math.min(turn++, steps.length - 1)]
    queueMicrotask(() => {
      if ('text' in step) {
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: step.text }],
          api: 'openai-completions', provider: 'openai', model: 'fake',
          usage, stopReason: 'stop', timestamp: 0,
        } as AssistantMessage
        stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
        stream.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent)
        return
      }
      const content = step.calls.map((c, i) => ({
        type: 'toolCall' as const,
        id: `call_${turn}_${i}`,
        name: c.name,
        arguments: c.arguments,
      }))
      const message = {
        role: 'assistant', content,
        api: 'openai-completions', provider: 'openai', model: 'fake',
        usage, stopReason: 'toolUse', timestamp: 0,
      } as AssistantMessage
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      content.forEach((toolCall, contentIndex) => {
        stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message } as AssistantMessageEvent)
      })
      stream.push({ type: 'done', reason: 'toolUse', message } as AssistantMessageEvent)
    })
    return stream
  }) as StreamFn
}

/** Every call misses, like `read_file` on a path that does not exist — except AGENTS.md. */
function failingReadTool(): { tool: AgentTool; calls: any[] } {
  const calls: any[] = []
  const tool: AgentTool = {
    name: 'read_file',
    description: 'Read a file',
    label: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as any,
    execute: async (_id: string, params: any) => {
      calls.push(params)
      if (params.path === 'AGENTS.md') {
        return {
          content: [{ type: 'text' as const, text: '# Agents' }],
          details: { content: '# Agents' },
        }
      }
      return {
        content: [{ type: 'text' as const, text: `File not found: ${params.path}` }],
        details: { error: `File not found: ${params.path}` },
      }
    },
  }
  return { tool, calls }
}

function run(
  streamFn: StreamFn,
  tool: AgentTool,
  loopDetection?: { maxConsecutiveNoProgress: number },
) {
  return runAgentLoop({
    model: 'claude-sonnet-4-5',
    system: 'test',
    history: [],
    prompt: 'go',
    tools: [tool],
    streamFn,
    maxIterations: 20,
    ...(loopDetection ? { loopDetection } : {}),
  })
}

/** The no-progress stop is off by default (round 2); these tests opt in. */
const OPT_IN = { maxConsecutiveNoProgress: 5 }

describe('runAgentLoop — no_progress counts turns (opted in)', () => {
  test('five failing calls in ONE turn reach the model and the turn carries on', async () => {
    const { tool, calls } = failingReadTool()
    const result = await run(
      scriptedStream([
        { calls: [0, 1, 2, 3, 4].map((i) => ({ name: 'read_file', arguments: { path: `missing-${i}.txt` } })) },
        { text: 'those files do not exist' },
      ]),
      tool,
      OPT_IN,
    )

    expect(result.loopBreak).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(calls).toHaveLength(5)
    expect(result.toolCalls).toHaveLength(5)
    expect(result.text).toBe('those files do not exist')
  })

  test('five turns each with one failing call still stop the loop', async () => {
    const { tool, calls } = failingReadTool()
    const result = await run(
      scriptedStream([
        { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'b.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'c.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'd.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'e.txt' } }] },
        { text: 'never reached' },
      ]),
      tool,
      OPT_IN,
    )

    expect(result.loopBreak?.reason).toBe('no_progress')
    expect(result.loopBreak?.pattern).toBe(
      '5 turns in a row where every tool call failed — stop and ask for help instead of retrying',
    )
    expect(calls).toHaveLength(5)
    expect(result.text).not.toBe('never reached')
  })

  test('a turn with one success among failures resets the streak', async () => {
    const { tool } = failingReadTool()
    const result = await run(
      scriptedStream([
        { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'b.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'c.txt' } }] },
        { calls: [{ name: 'read_file', arguments: { path: 'd.txt' } }] },
        // The fifth turn: four misses and one hit — progress, so no stop.
        {
          calls: [
            { name: 'read_file', arguments: { path: 'e.txt' } },
            { name: 'read_file', arguments: { path: 'f.txt' } },
            { name: 'read_file', arguments: { path: 'g.txt' } },
            { name: 'read_file', arguments: { path: 'h.txt' } },
            { name: 'read_file', arguments: { path: 'AGENTS.md' } },
          ],
        },
        { text: 'found AGENTS.md' },
      ]),
      tool,
      OPT_IN,
    )

    expect(result.loopBreak).toBeUndefined()
    expect(result.text).toBe('found AGENTS.md')
  })

  test('by default the same ten failing turns never stop the loop', async () => {
    const { tool, calls } = failingReadTool()
    const turns = Array.from({ length: 10 }, (_, i) => ({
      calls: [{ name: 'read_file', arguments: { path: `missing-${i}.txt` } }],
    }))
    const result = await run(scriptedStream([...turns, { text: 'still trying' }]), tool)

    expect(result.loopBreak).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(calls).toHaveLength(10)
    expect(result.text).toBe('still trying')
  })
})

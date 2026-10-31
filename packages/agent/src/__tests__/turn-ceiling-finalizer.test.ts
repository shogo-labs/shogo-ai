// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-270 — the iteration ceiling is not an error.
 *
 * Production showed 297 turns (40% of all failed turns) ending in
 * `"Request was aborted."` because the loop skipped the tool-free finalizer at
 * the ceiling and wrote a boilerplate fallback with the abort text in it.
 * These tests drive the real loop with a scripted model.
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

function echoTool(): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file',
    label: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as any,
    execute: async (_id: string, params: any) => ({
      content: [{ type: 'text' as const, text: `contents of ${params.path}` }],
      details: { content: `contents of ${params.path}` },
    }),
  }
}

function run(streamFn: StreamFn, maxIterations = 2) {
  const deltas: string[] = []
  return runAgentLoop({
    model: 'claude-sonnet-4-5',
    system: 'test',
    history: [],
    prompt: 'go',
    tools: [echoTool()],
    streamFn,
    maxIterations,
    onTextDelta: (d) => deltas.push(d),
  }).then((result) => ({ result, deltas }))
}

const twoToolCalls: Step[] = [
  { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
  { calls: [{ name: 'read_file', arguments: { path: 'b.txt' } }] },
]

describe('iteration ceiling runs the tool-free finalizer', () => {
  test('the turn ends with the model summary, not with "Request was aborted."', async () => {
    const { result, deltas } = await run(
      scriptedStream([...twoToolCalls, { text: 'I read a.txt and b.txt; c.txt is still to do.' }]),
    )

    expect(result.abortReason).toBe('max_iterations')
    expect(result.text).toBe('I read a.txt and b.txt; c.txt is still to do.')
    // A ceiling is an incomplete turn, not a failure: nothing is surfaced as an
    // error, so no caller can print "recoverable provider error" or "aborted".
    expect(result.error).toBeUndefined()
    expect(result.failureClass).toBe('iteration_ceiling')
    expect(result.text.toLowerCase()).not.toContain('abort')
    expect(result.text.toLowerCase()).not.toContain('provider error')
  })

  test('the ceiling still reports maxIterationsExhausted so auto-continue can pick it up', async () => {
    const { result } = await run(
      scriptedStream([...twoToolCalls, { text: 'Halfway through.' }]),
    )
    expect(result.maxIterationsExhausted).toBe(true)
  })

  test('a finalizer that produces nothing falls back to a plain step-limit line', async () => {
    const { result, deltas } = await run(scriptedStream([...twoToolCalls, { text: '   ' }]))

    expect(result.text).toContain('step limit')
    expect(result.text).toContain('2 steps')
    expect(result.text.toLowerCase()).not.toContain('abort')
    expect(result.text.toLowerCase()).not.toContain('provider error')
    expect(deltas.join('')).toContain('step limit')
  })

  test('a user stop still ends the turn quietly, with no ceiling copy', async () => {
    const controller = new AbortController()
    const streamFn = scriptedStream([
      { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
      { text: 'never reached' },
    ])
    const wrapped: StreamFn = ((model: any, ctx: any, opts: any) => {
      controller.abort()
      return streamFn(model, ctx, opts)
    }) as StreamFn

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'test',
      history: [],
      prompt: 'go',
      tools: [echoTool()],
      streamFn: wrapped,
      maxIterations: 5,
      signal: controller.signal,
    })

    expect(result.abortReason).toBe('external')
    expect(result.text ?? '').not.toContain('step limit')
    expect(result.text ?? '').not.toContain('aborted')
  })
})

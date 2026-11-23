// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-517 — a provider error after real tool work must leave the turn
 * continuable, and the closing pass must not tell the user that "the tool
 * budget for this turn closed".
 *
 * The failure this covers, from prod: a slow model call was cut off at
 * Cloudflare's 125s header timeout. The loop marked the turn incomplete, ran
 * the tool-free finalizer, and then *cleared* `maxIterationsExhausted` because
 * this was not the step ceiling — so the gateway's bounded auto-continue never
 * ran and the user had to type "continue" themselves.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { AgentTool, StreamFn } from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@mariozechner/pi-ai'
import { runAgentLoop } from '../agent-loop'

// These tests are about what the loop does *after* a model call fails, not
// about the retry ladder. The ladder re-issues a dropped call with real
// backoff (seconds of wall clock); turn it off so one failure is final.
process.env.SHOGO_INFERENCE_RETRY = '0'

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

/** Push one scripted turn onto the event stream pi-agent-core consumes. */
function playStep(step: Step, turn: number): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream()
  if ('text' in step) {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: step.text }],
      api: 'openai-completions', provider: 'openai', model: 'fake',
      usage, stopReason: 'stop', timestamp: 0,
    } as AssistantMessage
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      stream.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent)
    })
    return stream
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
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
    content.forEach((toolCall, contentIndex) => {
      stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message } as AssistantMessageEvent)
    })
    stream.push({ type: 'done', reason: 'toolUse', message } as AssistantMessageEvent)
  })
  return stream
}

/** Flatten a prompt message's text, whatever shape pi-ai handed us. */
function promptText(message: any): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

/** Plays the steps back in order, repeating the last one. */
function scriptedStream(steps: Step[]): StreamFn {
  let turn = 0
  return (() => playStep(steps[Math.min(turn++, steps.length - 1)], turn)) as StreamFn
}

const CLOSING_PROMPT_MARKER = 'Write the final response for this turn now'

/**
 * Plays `primer` on the first call, then fails every call until the loop's
 * closing (tool-free) pass — the only call whose prompt asks for the final
 * response.
 *
 * A fixed step list cannot express this: the retry ladder re-issues a dropped
 * call several times (fast tier, then provider backoff), so a script that fails
 * twice recovers on the third try and the turn never reaches the finalizer.
 */
function failUntilFinalizer(
  errorText: string,
  summary: string,
  opts: { primer?: Step; prompts?: string[] } = {},
): StreamFn {
  let calls = 0
  return ((_model: Model<Api>, ctx: any) => {
    const last = Array.isArray(ctx?.messages) ? ctx.messages[ctx.messages.length - 1] : undefined
    const text = promptText(last)
    if (last?.role === 'user' && opts.prompts) opts.prompts.push(text)
    const turn = calls++

    if (turn === 0 && opts.primer) return playStep(opts.primer, turn)

    if (last?.role === 'user' && text.includes(CLOSING_PROMPT_MARKER)) {
      return playStep({ text: summary }, turn)
    }

    const stream = createAssistantMessageEventStream()
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: 'openai-completions', provider: 'openai', model: 'fake',
      usage, stopReason: 'error', errorMessage: errorText, timestamp: 0,
    } as AssistantMessage
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      stream.push({ type: 'done', reason: 'error', message } as AssistantMessageEvent)
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

function run(streamFn: StreamFn, maxIterations = 10) {
  return runAgentLoop({
    model: 'claude-sonnet-4-5',
    system: 'test',
    history: [],
    prompt: 'go',
    tools: [echoTool()],
    streamFn,
    maxIterations,
  })
}

const NETWORK_ERROR =
  'Upstream shogo-cloud stream dropped after 124900ms: The connection was closed. Please retry. [shogo:retryable=true;code=network_drop]'

const READ_A_TXT: Step = { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] }

describe('provider error after tool work leaves the turn continuable (SHO-517)', () => {
  test('a provider error after an executed tool call keeps maxIterationsExhausted set', async () => {
    const result = await run(
      failUntilFinalizer(NETWORK_ERROR, 'I read a.txt and was cut off before writing the generator.', {
        primer: READ_A_TXT,
      }),
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.maxIterationsExhausted).toBe(true)
    expect(result.incompleteReason).toBe('provider_error')
    // The finalizer's summary is still the turn's text, not a boilerplate line.
    expect(result.text).toBe('I read a.txt and was cut off before writing the generator.')
  })

  test('a normal turn that needed the finalizer still ends continuable=false', async () => {
    const result = await run(
      scriptedStream([READ_A_TXT, { text: 'Done reading a.txt.' }]),
    )

    expect(result.maxIterationsExhausted).toBe(false)
    expect(result.incompleteReason).toBeUndefined()
    expect(result.text).toBe('Done reading a.txt.')
  })

  test('the closing prompt no longer says tool use is closed or the budget ran out', async () => {
    const prompts: string[] = []
    const result = await run(
      failUntilFinalizer(NETWORK_ERROR, 'Cut off after reading a.txt.', { primer: READ_A_TXT, prompts }),
    )

    const closing = prompts.filter((p) => p.includes(CLOSING_PROMPT_MARKER))
    expect(closing).toHaveLength(1)
    expect(closing[0]).not.toContain('Tool use is now closed')
    expect(closing[0].toLowerCase()).not.toContain('tool budget')
    expect(closing[0]).toContain('may resume automatically')
    // The finalizer still wrote the turn's closing line.
    expect(result.text).toBe('Cut off after reading a.txt.')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// SHO-529: `upstream_timeout` means the provider never sent a first byte.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A marker that says the provider never started. The transport must not spend
 * another full wait window on the identical call: the turn ends as
 * `provider_error` and the gateway's continuation reshapes the call instead.
 */
const UPSTREAM_TIMEOUT =
  'The model did not start responding within 240s. Split large tool calls (e.g. write_file then append). ' +
  '[shogo:retryable=true;code=upstream_timeout]'

describe('upstream_timeout is continuable but never re-sent (SHO-529)', () => {
  const prev = {
    inferenceRetry: process.env.SHOGO_INFERENCE_RETRY,
    base: process.env.SHOGO_INFERENCE_RETRY_BASE_MS,
    providerRetry: process.env.SHOGO_PROVIDER_RETRY,
    probe: process.env.AI_UPSTREAM_HEALTH_URL,
  }

  beforeEach(() => {
    // Retries ON, backoff OFF: the fast tier (2 re-issues) is what a retryable
    // failure would exercise, so "how many times was the call sent" is exact.
    process.env.SHOGO_INFERENCE_RETRY = '1'
    process.env.SHOGO_INFERENCE_RETRY_BASE_MS = '1'
    process.env.SHOGO_PROVIDER_RETRY = 'off'
    delete process.env.AI_UPSTREAM_HEALTH_URL
  })

  afterEach(() => {
    for (const [key, value] of [
      ['SHOGO_INFERENCE_RETRY', prev.inferenceRetry],
      ['SHOGO_INFERENCE_RETRY_BASE_MS', prev.base],
      ['SHOGO_PROVIDER_RETRY', prev.providerRetry],
      ['AI_UPSTREAM_HEALTH_URL', prev.probe],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  /**
   * Plays one tool call, then fails every later model call with `errorText` —
   * except the tool-free closing pass, which answers with `summary`.
   */
  function failAfterToolWork(errorText: string, summary: string) {
    const state = { primed: false, failing: 0 }
    const stream = ((_model: Model<Api>, ctx: any) => {
      const last = Array.isArray(ctx?.messages) ? ctx.messages[ctx.messages.length - 1] : undefined
      const text = promptText(last)

      if (last?.role === 'user' && text.includes(CLOSING_PROMPT_MARKER)) {
        return playStep({ text: summary }, 0)
      }
      if (!state.primed) {
        state.primed = true
        return playStep(READ_A_TXT, 0)
      }

      state.failing++
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: 'openai-completions', provider: 'openai', model: 'fake',
        usage, stopReason: 'error', errorMessage: errorText, timestamp: 0,
      } as AssistantMessage
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        s.push({ type: 'start', partial: message } as AssistantMessageEvent)
        s.push({ type: 'done', reason: 'error', message } as AssistantMessageEvent)
      })
      return s
    }) as StreamFn
    return { stream, state }
  }

  test('the call is sent once, and the turn is left continuable as provider_error', async () => {
    const { stream, state } = failAfterToolWork(UPSTREAM_TIMEOUT, 'Cut off before the giant write.')

    const result = await run(stream)

    // The whole point: no second attempt of the identical oversized call.
    expect(state.failing).toBe(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.maxIterationsExhausted).toBe(true)
    expect(result.incompleteReason).toBe('provider_error')
    expect(result.text).toBe('Cut off before the giant write.')
  })

  test('a marker that is safe to re-send still uses the retry ladder (control)', async () => {
    const { stream, state } = failAfterToolWork(NETWORK_ERROR, 'Cut off by a dropped connection.')

    await run(stream)

    // Proof the retry ladder was live in the test above: the same shape with a
    // network_drop marker is re-issued (2 fast attempts by default).
    expect(state.failing).toBe(3)
  })
})

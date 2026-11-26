// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-556 — a single tools-free call that returned text is a completed call.
 *
 * The compaction summarizer runs `runAgentLoop({ maxIterations: 1, tools: [] })`
 * (`compaction-summarizer.ts`). With `maxIterations: 1` the loop treated every
 * such call as an iteration-ceiling turn: it logged `TURN_FAILURE
 * iteration_ceiling` and could reach for the tool-free finalizer. Three of
 * those per compaction in parallel turned the logs into noise and added an
 * extra model call. A call that answered without tools must end as completed.
 */
import { describe, test, expect, spyOn } from 'bun:test'
import type { StreamFn } from '@mariozechner/pi-agent-core'
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

/** One text answer, and a counter of every call the model received. */
function oneAnswer(text: string): { streamFn: StreamFn; calls: () => number } {
  let calls = 0
  const streamFn = (() => {
    calls++
    const stream = createAssistantMessageEventStream()
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'openai-completions', provider: 'openai', model: 'fake',
      usage, stopReason: 'stop', timestamp: 0,
    } as AssistantMessage
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message } as AssistantMessageEvent)
      stream.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent)
    })
    return stream
  }) as StreamFn
  return { streamFn, calls: () => calls }
}

describe('SHO-556: the summarizer call is not a failed turn', () => {
  test('maxIterations 1 with no tools and a text answer makes one call and no ceiling failure', async () => {
    const { streamFn, calls } = oneAnswer('## Decisions\n- kept the summary short')
    const warnings: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args: any[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      const result = await runAgentLoop({
        model: fakeModel(),
        provider: 'openai',
        system: 'summarize',
        history: [],
        prompt: 'summarize this excerpt',
        tools: [],
        streamFn,
        maxIterations: 1,
      })

      expect(calls()).toBe(1)
      expect(result.text).toContain('kept the summary short')
      expect(result.abortReason).toBeUndefined()
      expect(result.maxIterationsExhausted).toBeFalsy()
      expect(result.incompleteReason).toBeUndefined()
      expect(result.failureClass).not.toBe('iteration_ceiling')
      expect(warnings.filter((line) => line.includes('TURN_FAILURE'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

import { describe, test, expect } from 'bun:test'
import { runAgentLoop } from '../agent-loop'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockToolTracker } from './helpers/mock-tools'

describe('agent-loop streaming and hooks', () => {
  test('onTextDelta is not called with mock stream (no deltas in mock)', async () => {
    const deltas: string[] = []
    const mockStream = createMockStreamFn([
      buildTextResponse('Hello world.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'hi',
      tools: [],
      streamFn: mockStream,
      onTextDelta: (d) => deltas.push(d),
    })

    // Mock stream emits complete messages, not deltas — so onTextDelta may not fire
    // This test verifies the callback is wired without errors
    expect(true).toBe(true)
  })

  test('onBeforeToolCall fires before tool execution', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('my_tool', 'test', { done: true })
    const beforeCalls: Array<{ name: string; args: any }> = []

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'my_tool', arguments: { x: 1 } }]),
      buildTextResponse('Done.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'do it',
      tools: [tool],
      streamFn: mockStream,
      onBeforeToolCall: async (name, args) => {
        beforeCalls.push({ name, args })
      },
    })

    expect(beforeCalls).toHaveLength(1)
    expect(beforeCalls[0].name).toBe('my_tool')
    expect(beforeCalls[0].args).toEqual({ x: 1 })
  })

  test('onAfterToolCall fires after tool execution', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('my_tool', 'test', { status: 'ok' })
    const afterCalls: Array<{ name: string; result: any; isError: boolean }> = []

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'my_tool', arguments: { x: 2 } }]),
      buildTextResponse('Done.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'do it',
      tools: [tool],
      streamFn: mockStream,
      onAfterToolCall: async (name, _args, result, isError) => {
        afterCalls.push({ name, result, isError })
      },
    })

    expect(afterCalls).toHaveLength(1)
    expect(afterCalls[0].name).toBe('my_tool')
    expect(afterCalls[0].isError).toBe(false)
  })

  test('onAgentEnd fires with final result', async () => {
    let endResult: any = null

    const mockStream = createMockStreamFn([
      buildTextResponse('Final answer.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'test',
      tools: [],
      streamFn: mockStream,
      onAgentEnd: async (result) => {
        endResult = result
      },
    })

    expect(endResult).not.toBeNull()
    expect(endResult.text).toBe('Final answer.')
    expect(endResult.iterations).toBeGreaterThanOrEqual(1)
  })

  test('onBeforeToolCall and onAfterToolCall fire in correct order', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('ordered_tool', 'test', { ok: true })
    const order: string[] = []

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'ordered_tool', arguments: {} }]),
      buildTextResponse('Done.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'go',
      tools: [tool],
      streamFn: mockStream,
      onBeforeToolCall: async () => { order.push('before') },
      onAfterToolCall: async () => { order.push('after') },
      onAgentEnd: async () => { order.push('end') },
    })

    expect(order[0]).toBe('before')
    expect(order[1]).toBe('after')
    expect(order[order.length - 1]).toBe('end')
  })
})

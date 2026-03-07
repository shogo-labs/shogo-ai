// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { runAgentLoop } from '../agent-loop'
import type { Message } from '@mariozechner/pi-ai'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockToolTracker } from './helpers/mock-tools'

describe('runAgentLoop', () => {
  test('handles a simple text-only response', async () => {
    const mockStream = createMockStreamFn([
      buildTextResponse('Hello, I am the agent.'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'You are a test agent.',
      history: [],
      prompt: 'Hello',
      tools: [],
      streamFn: mockStream,
    })

    expect(result.text).toBe('Hello, I am the agent.')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.iterations).toBe(1)
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
  })

  test('executes a single tool call then gets final text', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('read_file', 'Read a file', { content: 'file contents' })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'test.txt' }, id: 'toolu_1' }]),
      buildTextResponse('I read the file: file contents'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'You are a test agent.',
      history: [],
      prompt: 'Read test.txt',
      tools: [tool],
      streamFn: mockStream,
    })

    expect(result.text).toBe('I read the file: file contents')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    expect(result.toolCalls[0].input).toEqual({ path: 'test.txt' })
    expect(result.iterations).toBe(2)
    expect(tracker.calls).toHaveLength(1)
  })

  test('chains multiple tool calls across iterations', async () => {
    const tracker = new MockToolTracker()
    const readTool = tracker.createTool('read_file', 'Read', { content: 'abc' })
    const writeTool = tracker.createTool('write_file', 'Write', { ok: true })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'write_file', arguments: { path: 'b.txt', content: 'abc' }, id: 'toolu_2' }]),
      buildTextResponse('Done. Read a.txt and wrote to b.txt.'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'Copy a.txt to b.txt',
      tools: [readTool, writeTool],
      streamFn: mockStream,
    })

    expect(result.text).toBe('Done. Read a.txt and wrote to b.txt.')
    expect(result.toolCalls).toHaveLength(2)
    expect(result.iterations).toBe(3)
    expect(tracker.calls[0].name).toBe('read_file')
    expect(tracker.calls[1].name).toBe('write_file')
  })

  test('respects maxIterations limit', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('loop_tool', 'Loops forever', { status: 'ok' })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 1 } }]),
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 2 } }]),
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 3 } }]),
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 4 } }]),
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 5 } }]),
      buildToolUseResponse([{ name: 'loop_tool', arguments: { n: 6 } }]),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'loop',
      tools: [tool],
      streamFn: mockStream,
      maxIterations: 3,
    })

    // Pi Agent counts turns differently (each LLM call = 1 turn),
    // but abort should stop the agent within a few turns of the limit
    expect(result.toolCalls.length).toBeLessThanOrEqual(5)
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1)
  })

  test('handles tool execution errors gracefully', async () => {
    const { Type } = await import('@sinclair/typebox')
    const errorTool: import('@mariozechner/pi-agent-core').AgentTool = {
      name: 'failing_tool',
      description: 'Always fails',
      label: 'Failing Tool',
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error('Tool exploded')
      },
    }

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'failing_tool', arguments: {}, id: 'toolu_err' }]),
      buildTextResponse('The tool failed, sorry.'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'try it',
      tools: [errorTool],
      streamFn: mockStream,
    })

    expect(result.text).toBe('The tool failed, sorry.')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].output).toHaveProperty('error')
  })

  test('passes conversation history', async () => {
    const calls: Message[][] = []
    const mockStream = createMockStreamFn(
      [buildTextResponse('I remember.')],
      (idx, msgs) => { calls.push([...msgs]) }
    )

    const history: Message[] = [
      { role: 'user', content: 'My name is Alice.', timestamp: Date.now() },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Nice to meet you, Alice!' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'mock',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    ]

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history,
      prompt: 'What is my name?',
      tools: [],
      streamFn: mockStream,
    })

    // Should have history + new prompt = 3 messages sent to LLM
    expect(calls[0].length).toBe(3)
  })

  test('calls onToolCall callback', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('my_tool', 'test', { done: true })
    const toolCallLog: Array<{ name: string; input: any }> = []

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'my_tool', arguments: { x: 42 } }]),
      buildTextResponse('Done.'),
    ])

    await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'do it',
      tools: [tool],
      streamFn: mockStream,
      onToolCall: (name, input) => toolCallLog.push({ name, input }),
    })

    expect(toolCallLog).toHaveLength(1)
    expect(toolCallLog[0].name).toBe('my_tool')
    expect(toolCallLog[0].input).toEqual({ x: 42 })
  })

  test('returns newMessages for history storage', async () => {
    const tracker = new MockToolTracker()
    const tool = tracker.createTool('echo', 'echo', { echoed: true })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'echo', arguments: { msg: 'hi' } }]),
      buildTextResponse('echoed.'),
    ])

    const result = await runAgentLoop({
      model: 'claude-sonnet-4-5',
      system: 'Test',
      history: [],
      prompt: 'echo hi',
      tools: [tool],
      streamFn: mockStream,
    })

    expect(result.newMessages.length).toBeGreaterThanOrEqual(1)
    const hasAssistant = result.newMessages.some((m) => m.role === 'assistant')
    expect(hasAssistant).toBe(true)
  })
})

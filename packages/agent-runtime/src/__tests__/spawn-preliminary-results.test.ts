// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the AI SDK preliminary tool results pattern
 * used by buildSpawnCallbacks + runSubagent.
 *
 * Phase 1: Real — exercises runSubagent with a mock LLM stream
 * Phase 2: Mock — tests buildSpawnCallbacks directly with simulated callbacks
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSubagent, type SubagentConfig, type SubagentStreamCallbacks } from '../subagent'
import { buildSpawnCallbacks, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from '../pi-adapter'
import { MockToolTracker } from './helpers/mock-tools'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WrittenEvent {
  type: string
  toolCallId?: string
  output?: any
  preliminary?: boolean
  dynamic?: boolean
  [key: string]: any
}

function createMockWriter(): { write: (ev: any) => void; events: WrittenEvent[] } {
  const events: WrittenEvent[] = []
  return {
    write: (ev: any) => events.push(ev),
    events,
  }
}

function createTestCtx(workspaceDir: string, overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
    },
    projectId: 'test-spawn',
    fileStateCache: new FileStateCache(),
    ...overrides,
  } as ToolContext
}

// ---------------------------------------------------------------------------
// Phase 1: Real integration — runSubagent with mock LLM
// ---------------------------------------------------------------------------

describe('spawn preliminary results — real integration', () => {
  const workspaceDir = join(tmpdir(), `shogo-test-spawn-prelim-${Date.now()}`)

  beforeAll(() => {
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(join(workspaceDir, 'test.txt'), 'hello world\n')
  })

  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('sub-agent lifecycle: onStart captures agentId, onEnd flushes', async () => {
    const w = createMockWriter()
    const spawnToolCallId = 'spawn-tc-001'
    const spawn = buildSpawnCallbacks(w, spawnToolCallId)!

    // Mock stream: text-only response (no tool calls).
    // Note: mock stream does NOT emit text_delta events — only tool
    // execution events. Text streaming is tested in Phase 2 (mock callbacks).
    const mockStream = createMockStreamFn([
      buildTextResponse('I found the answer: 42'),
    ])

    const ctx = createTestCtx(workspaceDir)
    const config: SubagentConfig = {
      name: 'test-agent',
      description: 'Test sub-agent',
      systemPrompt: 'You are a test agent.',
      maxTurns: 1,
    }

    const result = await runSubagent(config, 'What is the answer?', ctx, [], spawn.callbacks, {
      streamFn: mockStream,
    })

    expect(result.agentId).toBeDefined()
    expect(result.agentId).toMatch(/^a-test-agent-/)
    expect(result.responseText).toContain('42')

    // onStart should have captured the agentId
    const accumulated = spawn.getAccumulatedOutput()
    expect(accumulated.agentId).toBe(result.agentId!)

    // onEnd flushed a preliminary event (even if empty parts — it's a complete snapshot)
    const prelimEvents = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )
    expect(prelimEvents.length).toBeGreaterThanOrEqual(1)

    // Every preliminary event targets the spawn tool call
    for (const ev of prelimEvents) {
      expect(ev.toolCallId).toBe(spawnToolCallId)
      expect(ev.dynamic).toBe(true)
      expect(ev.output.agentId).toBe(result.agentId)
      expect(Array.isArray(ev.output.parts)).toBe(true)
    }
  })

  test('sub-agent with tool calls emits tool parts via onBeforeToolCall/onAfterToolCall', async () => {
    const tracker = new MockToolTracker()
    const readTool = tracker.createTool('read_file', 'Read a file', { content: 'file contents' })

    const w = createMockWriter()
    const spawnToolCallId = 'spawn-tc-002'
    const spawn = buildSpawnCallbacks(w, spawnToolCallId)!

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'test.txt' }, id: 'tc-inner-1' }]),
      buildTextResponse('The file contains: file contents'),
    ])

    const ctx = createTestCtx(workspaceDir)
    const config: SubagentConfig = {
      name: 'reader',
      description: 'File reader agent',
      systemPrompt: 'Read files when asked.',
      maxTurns: 3,
    }

    const result = await runSubagent(config, 'Read test.txt', ctx, [readTool], spawn.callbacks, {
      streamFn: mockStream,
    })

    const accumulated = spawn.getAccumulatedOutput()
    expect(accumulated.agentId).toBe(result.agentId!)

    // Tool parts should be present (onBeforeToolCall / onAfterToolCall fire with mock stream)
    const toolParts = accumulated.parts.filter((p: any) => p.type === 'tool')
    expect(toolParts.length).toBeGreaterThanOrEqual(1)

    // Tool part should have completed with result
    const tp = toolParts[0]
    expect(tp.tool.toolName).toBe('read_file')
    expect(tp.tool.state).toBe('success')
    expect(tp.tool.result).toBeDefined()

    // All preliminary events should be well-formed snapshots
    const prelimEvents = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )
    expect(prelimEvents.length).toBeGreaterThanOrEqual(1)
    for (const ev of prelimEvents) {
      expect(ev.toolCallId).toBe(spawnToolCallId)
      expect(ev.output.agentId).toBe(result.agentId)
      expect(Array.isArray(ev.output.parts)).toBe(true)
    }

    // The last preliminary event should contain the completed tool
    const last = prelimEvents[prelimEvents.length - 1]
    const lastToolParts = last.output.parts.filter((p: any) => p.type === 'tool')
    expect(lastToolParts.length).toBeGreaterThanOrEqual(1)
    expect(lastToolParts[0].tool.state).toBe('success')
  })

  test('multiple concurrent sub-agents produce separate part streams', async () => {
    const tracker = new MockToolTracker()
    const toolA = tracker.createTool('tool_a', 'Tool A', { from: 'A' })
    const toolB = tracker.createTool('tool_b', 'Tool B', { from: 'B' })

    const w = createMockWriter()
    const spawn1 = buildSpawnCallbacks(w, 'spawn-tc-A')!
    const spawn2 = buildSpawnCallbacks(w, 'spawn-tc-B')!

    const streamA = createMockStreamFn([
      buildToolUseResponse([{ name: 'tool_a', arguments: {}, id: 'tc-a1' }]),
      buildTextResponse('Done A'),
    ])
    const streamB = createMockStreamFn([
      buildToolUseResponse([{ name: 'tool_b', arguments: {}, id: 'tc-b1' }]),
      buildTextResponse('Done B'),
    ])

    const ctx = createTestCtx(workspaceDir)
    const configA: SubagentConfig = { name: 'agent-a', description: 'A', systemPrompt: 'A', maxTurns: 3 }
    const configB: SubagentConfig = { name: 'agent-b', description: 'B', systemPrompt: 'B', maxTurns: 3 }

    const [resultA, resultB] = await Promise.all([
      runSubagent(configA, 'go A', ctx, [toolA], spawn1.callbacks, { streamFn: streamA }),
      runSubagent(configB, 'go B', ctx, [toolB], spawn2.callbacks, { streamFn: streamB }),
    ])

    // Each spawn tracked its own agentId
    expect(spawn1.getAccumulatedOutput().agentId).toBe(resultA.agentId!)
    expect(spawn2.getAccumulatedOutput().agentId).toBe(resultB.agentId!)
    expect(resultA.agentId).not.toBe(resultB.agentId)

    // Events are scoped by toolCallId — no cross-contamination
    const eventsA = w.events.filter((e) => e.toolCallId === 'spawn-tc-A')
    const eventsB = w.events.filter((e) => e.toolCallId === 'spawn-tc-B')

    expect(eventsA.length).toBeGreaterThan(0)
    expect(eventsB.length).toBeGreaterThan(0)

    // Agent A's parts only contain tool_a
    const partsA = eventsA
      .filter((e) => e.preliminary)
      .flatMap((e) => e.output.parts.filter((p: any) => p.type === 'tool'))
    const partsB = eventsB
      .filter((e) => e.preliminary)
      .flatMap((e) => e.output.parts.filter((p: any) => p.type === 'tool'))

    expect(partsA.some((p: any) => p.tool.toolName === 'tool_a')).toBe(true)
    expect(partsA.some((p: any) => p.tool.toolName === 'tool_b')).toBe(false)
    expect(partsB.some((p: any) => p.tool.toolName === 'tool_b')).toBe(true)
    expect(partsB.some((p: any) => p.tool.toolName === 'tool_a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase 2: Mock — direct callback simulation
// ---------------------------------------------------------------------------

describe('spawn preliminary results — mock callbacks', () => {
  test('buildSpawnCallbacks returns undefined when writer is null', () => {
    const result = buildSpawnCallbacks(null, 'tc-1')
    expect(result).toBeUndefined()
  })

  test('onStart captures agentId', () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-abc123')

    const output = spawn.getAccumulatedOutput()
    expect(output.agentId).toBe('a-test-abc123')
    expect(output.parts).toEqual([])
  })

  test('text deltas accumulate into a single text part', () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-001')

    spawn.callbacks.onTextDelta!('Hello ')
    spawn.callbacks.onTextDelta!('world')
    spawn.callbacks.onTextDelta!('!')

    const output = spawn.getAccumulatedOutput()
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].type).toBe('text')
    expect(output.parts[0].text).toBe('Hello world!')
  })

  test('reasoning parts are tracked with streaming state', () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-002')

    spawn.callbacks.onThinkingStart!()
    spawn.callbacks.onThinkingDelta!('Let me think...')
    spawn.callbacks.onThinkingDelta!(' about this.')

    let output = spawn.getAccumulatedOutput()
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].type).toBe('reasoning')
    expect(output.parts[0].text).toBe('Let me think... about this.')
    expect(output.parts[0].isStreaming).toBe(true)

    spawn.callbacks.onThinkingEnd!()

    output = spawn.getAccumulatedOutput()
    expect(output.parts[0].isStreaming).toBe(false)
  })

  test('tool calls are tracked through lifecycle', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-003')

    // onToolCallStart creates the part
    spawn.callbacks.onToolCallStart!('read_file', 'inner-tc-1')

    let output = spawn.getAccumulatedOutput()
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].type).toBe('tool')
    expect(output.parts[0].tool.toolName).toBe('read_file')
    expect(output.parts[0].tool.state).toBe('streaming')

    // onBeforeToolCall sets args
    await spawn.callbacks.onBeforeToolCall!('read_file', { path: 'a.txt' }, 'inner-tc-1')

    output = spawn.getAccumulatedOutput()
    expect(output.parts[0].tool.args).toEqual({ path: 'a.txt' })

    // onAfterToolCall sets result
    await spawn.callbacks.onAfterToolCall!('read_file', { path: 'a.txt' }, { content: 'data' }, false, 'inner-tc-1')

    output = spawn.getAccumulatedOutput()
    expect(output.parts[0].tool.state).toBe('success')
    expect(output.parts[0].tool.result).toEqual({ content: 'data' })
  })

  test('tool error state is captured', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-004')

    await spawn.callbacks.onBeforeToolCall!('bad_tool', {}, 'inner-tc-err')
    await spawn.callbacks.onAfterToolCall!('bad_tool', {}, 'Permission denied', true, 'inner-tc-err')

    const output = spawn.getAccumulatedOutput()
    expect(output.parts[0].tool.state).toBe('error')
    expect(output.parts[0].tool.result).toEqual({ error: 'Permission denied' })
  })

  test('mixed content produces correct part sequence', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-005')

    // Reasoning
    spawn.callbacks.onThinkingStart!()
    spawn.callbacks.onThinkingDelta!('I should read the file.')
    spawn.callbacks.onThinkingEnd!()

    // Tool call
    spawn.callbacks.onToolCallStart!('read_file', 'inner-tc-1')
    await spawn.callbacks.onBeforeToolCall!('read_file', { path: 'x.ts' }, 'inner-tc-1')
    await spawn.callbacks.onAfterToolCall!('read_file', { path: 'x.ts' }, { ok: true }, false, 'inner-tc-1')

    // Text response
    spawn.callbacks.onTextDelta!('Done reading the file.')

    const output = spawn.getAccumulatedOutput()
    expect(output.parts).toHaveLength(3)
    expect(output.parts[0].type).toBe('reasoning')
    expect(output.parts[1].type).toBe('tool')
    expect(output.parts[2].type).toBe('text')
  })

  test('preliminary events are throttled', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-006')

    // Rapid-fire 20 text deltas
    for (let i = 0; i < 20; i++) {
      spawn.callbacks.onTextDelta!(`chunk${i} `)
    }

    // Should have fewer events than 20 (throttled)
    const prelimEvents = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )
    expect(prelimEvents.length).toBeLessThan(20)
    expect(prelimEvents.length).toBeGreaterThanOrEqual(1)

    // Wait for any pending throttled emit
    await new Promise((r) => setTimeout(r, 200))

    const allPrelim = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )

    // Last emitted event should have all 20 chunks
    const last = allPrelim[allPrelim.length - 1]
    const fullText = last.output.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('')
    expect(fullText).toContain('chunk0')
    expect(fullText).toContain('chunk19')
  })

  test('onEnd flushes pending throttled emission', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-007')

    spawn.callbacks.onTextDelta!('final text')
    spawn.callbacks.onEnd!('test')

    // onEnd should have forced a flush
    const prelimEvents = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )
    expect(prelimEvents.length).toBeGreaterThanOrEqual(1)

    const last = prelimEvents[prelimEvents.length - 1]
    expect(last.output.parts[0].text).toBe('final text')
  })

  test('each preliminary emission is a complete snapshot (not a delta)', () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-008')

    // First emission
    spawn.callbacks.onThinkingStart!()
    spawn.callbacks.onThinkingEnd!()

    // Second emission (forced)
    spawn.callbacks.onTextDelta!('Hello')
    spawn.callbacks.onEnd!('test')

    const prelimEvents = w.events.filter(
      (e) => e.type === 'tool-output-available' && e.preliminary === true,
    )

    // Each later emission should contain ALL prior parts (it's a snapshot)
    const last = prelimEvents[prelimEvents.length - 1]
    expect(last.output.parts.length).toBe(2)
    expect(last.output.parts[0].type).toBe('reasoning')
    expect(last.output.parts[1].type).toBe('text')
  })

  test('onBeforeToolCall creates tool part if onToolCallStart was not called', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-009')

    // Skip onToolCallStart — go straight to onBeforeToolCall
    await spawn.callbacks.onBeforeToolCall!('write_file', { path: 'out.txt', content: 'hi' }, 'inner-tc-direct')

    const output = spawn.getAccumulatedOutput()
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].type).toBe('tool')
    expect(output.parts[0].tool.toolName).toBe('write_file')
    expect(output.parts[0].tool.args).toEqual({ path: 'out.txt', content: 'hi' })
  })

  test('JSON string results are parsed in onAfterToolCall', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-010')

    await spawn.callbacks.onBeforeToolCall!('some_tool', {}, 'inner-tc-json')
    await spawn.callbacks.onAfterToolCall!('some_tool', {}, '{"key": "value"}', false, 'inner-tc-json')

    const output = spawn.getAccumulatedOutput()
    expect(output.parts[0].tool.result).toEqual({ key: 'value' })
  })

  test('getAccumulatedOutput returns defensive copy', () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-1')!
    spawn.callbacks.onStart!('test', 'desc', 'a-test-011')
    spawn.callbacks.onTextDelta!('text 1')

    const output1 = spawn.getAccumulatedOutput()
    spawn.callbacks.onTextDelta!(' text 2')
    const output2 = spawn.getAccumulatedOutput()

    // output1 should be a snapshot — not affected by further mutations
    expect(output1.parts).toHaveLength(1)
    expect(output2.parts).toHaveLength(1)
    // But the text content grows (parts array is shallow-copied, inner objects are shared)
    // What matters is the array reference is different
    expect(output1.parts).not.toBe(output2.parts)
  })
})

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
import { buildSpawnCallbacks, subagentToolResult, type ToolContext } from '../gateway-tools'
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

  test('tool transitions are throttled, not forced', async () => {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'tc-throttle')!
    spawn.callbacks.onStart!('browser_qa', 'desc', 'a-browser_qa-throttle')

    for (let i = 0; i < 10; i++) {
      await spawn.callbacks.onBeforeToolCall!('browser', { action: 'snapshot' }, `c-${i}`)
      await spawn.callbacks.onAfterToolCall!('browser', { action: 'snapshot' }, { ok: true }, false, `c-${i}`)
    }

    const frames = w.events.filter((e) => e.type === 'tool-output-available' && e.preliminary === true)
    expect(frames.length).toBeLessThan(10)
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

// ---------------------------------------------------------------------------
// Phase 3: a long browser_qa run must not grow every frame (SHO-340)
// ---------------------------------------------------------------------------

describe('spawn preliminary results — bounded frames', () => {
  const STEPS = 200
  const SNAPSHOT_CHARS = 50_000
  const FILE_CHARS = 30_000
  /** SUBAGENT_SNAPSHOT_MAX_CHARS (256 KB) plus the collapsed stubs behind it. */
  const FRAME_LIMIT = 300_000

  function snapshotResult() {
    return {
      ok: true,
      // A real accessibility tree: many short strings, so a per-string cap
      // alone would not shrink it.
      snapshot: Array.from({ length: 500 }, (_, i) => `- [${i}] link "row ${i}"`),
      raw: 'x'.repeat(SNAPSHOT_CHARS),
    }
  }

  async function runLongBrowserQa() {
    const w = createMockWriter()
    const spawn = buildSpawnCallbacks(w, 'spawn-tc-long')!
    spawn.callbacks.onStart!('browser_qa', 'run the app', 'a-browser_qa-long')

    for (let step = 0; step < STEPS; step++) {
      const callId = `call-${step}`
      spawn.callbacks.onToolCallStart!('browser', callId)
      await spawn.callbacks.onBeforeToolCall!('browser', { action: 'snapshot' }, callId)
      await spawn.callbacks.onAfterToolCall!('browser', { action: 'snapshot' }, snapshotResult(), false, callId)

      const fileId = `file-${step}`
      const args = { path: `reports/step-${step}.md`, content: 'y'.repeat(FILE_CHARS) }
      spawn.callbacks.onToolCallStart!('write_file', fileId)
      await spawn.callbacks.onBeforeToolCall!('write_file', args, fileId)
      await spawn.callbacks.onAfterToolCall!('write_file', args, { success: true }, false, fileId)

      spawn.callbacks.onTextDelta!(`step ${step} done `)
      // Flush the throttle, as onEnd does, so every step has a frame to measure.
      spawn.callbacks.onEnd!('browser_qa')
    }
    return { w, spawn }
  }

  test('every frame stays under the bound as the run grows', async () => {
    const { w } = await runLongBrowserQa()
    const frames = w.events.filter((e) => e.type === 'tool-output-available' && e.preliminary === true)
    expect(frames.length).toBeGreaterThan(STEPS)

    const sizes = frames.map((f) => JSON.stringify(f.output).length)
    const over = sizes.filter((s) => s > FRAME_LIMIT)
    expect(over, `frames over ${FRAME_LIMIT} chars: ${over.length} (largest ${Math.max(...sizes)})`).toEqual([])

    // Flat, not quadratic: the frame late in the run is the same order of size
    // as the one early on.
    const early = sizes[Math.floor(sizes.length / 5)]
    const late = sizes[sizes.length - 1]
    expect(late).toBeLessThanOrEqual(early * 2)
  })

  test('the accumulated transcript is capped too', async () => {
    const { spawn } = await runLongBrowserQa()
    const parts = spawn.getAccumulatedOutput().parts
    expect(parts.length).toBeGreaterThanOrEqual(STEPS * 2)

    expect(JSON.stringify(parts).length).toBeLessThan(FRAME_LIMIT)
    const strings = (value: any, out: string[] = []): string[] => {
      if (typeof value === 'string') out.push(value)
      else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
      else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
      return out
    }
    for (const s of strings(parts)) {
      expect(s.length).toBeLessThanOrEqual(8_200)
    }
    expect(parts.some((p: any) => p.truncated === true)).toBe(true)
  })

  test('the parent model never sees the transcript', () => {
    const parts = Array.from({ length: 200 }, (_, i) => ({
      type: 'tool',
      id: `call-${i}`,
      tool: { toolName: 'browser', state: 'success', args: { action: 'snapshot' }, result: snapshotResult() },
    }))
    const details = {
      instance_id: 'inst-1',
      agent_id: 'a-browser_qa-1',
      status: 'completed',
      toolCalls: 200,
      iterations: 210,
      tokens: { input: 1000, output: 100 },
      model: 'sonnet',
      parts,
    }
    const withParts = subagentToolResult(details, 'the report')
    // Same shape, same tool names, tiny results: the model-facing text must not
    // depend on how much the transcript carries.
    const slimParts = parts.map((p) => ({ ...p, tool: { ...p.tool, result: { ok: true } } }))
    const withSlimParts = subagentToolResult({ ...details, parts: slimParts }, 'the report')

    const modelText = (withParts.content[0] as { text: string }).text
    expect(modelText).toBe((withSlimParts.content[0] as { text: string }).text)
    expect(modelText.length).toBeLessThan(2_000)
    expect(modelText).not.toContain('row 499')
  })
})

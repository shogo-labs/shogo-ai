// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Orchestration Tests
 *
 * Tests for:
 * - Semaphore and WriteMutex async primitives
 * - partitionToolCalls batching logic
 * - wrapToolsWithOrchestration integration
 * - Concurrency behavior: reads parallel, writes serialized
 */

import { describe, test, expect } from 'bun:test'
import {
  Semaphore,
  WriteMutex,
  partitionToolCalls,
  isConcurrencySafe,
  CONCURRENT_SAFE_TOOLS,
  wrapToolsWithOrchestration,
} from '../tool-orchestration'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { Type } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, delayMs = 0): AgentTool {
  return {
    name,
    description: `Mock ${name}`,
    label: name,
    parameters: Type.Object({}),
    execute: async () => {
      if (delayMs > 0) await sleep(delayMs)
      return {
        content: [{ type: 'text' as const, text: `result:${name}` }],
        details: { name },
      }
    },
  }
}

function makeTimingTool(name: string, log: string[], delayMs = 50): AgentTool {
  return {
    name,
    description: `Timing ${name}`,
    label: name,
    parameters: Type.Object({}),
    execute: async () => {
      log.push(`start:${name}`)
      await sleep(delayMs)
      log.push(`end:${name}`)
      return {
        content: [{ type: 'text' as const, text: `done:${name}` }],
        details: { name },
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

describe('Semaphore', () => {
  test('allows up to max concurrent acquisitions', async () => {
    const sem = new Semaphore(3)
    expect(sem.available).toBe(3)

    await sem.acquire()
    await sem.acquire()
    await sem.acquire()
    expect(sem.available).toBe(0)

    sem.release()
    expect(sem.available).toBe(1)
  })

  test('blocks when exhausted and resumes on release', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let acquired = false
    const p = sem.acquire().then(() => { acquired = true })
    await sleep(10)
    expect(acquired).toBe(false)
    expect(sem.waiting).toBe(1)

    sem.release()
    await p
    expect(acquired).toBe(true)
  })

  test('wakes waiters in FIFO order', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const order: number[] = []
    const p1 = sem.acquire().then(() => { order.push(1) })
    const p2 = sem.acquire().then(() => { order.push(2) })
    const p3 = sem.acquire().then(() => { order.push(3) })

    sem.release(); await p1
    sem.release(); await p2
    sem.release(); await p3

    expect(order).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// WriteMutex
// ---------------------------------------------------------------------------

describe('WriteMutex', () => {
  test('allows one holder at a time', async () => {
    const mutex = new WriteMutex()
    expect(mutex.isLocked).toBe(false)

    await mutex.acquire()
    expect(mutex.isLocked).toBe(true)

    mutex.release()
    expect(mutex.isLocked).toBe(false)
  })

  test('blocks second acquirer until release', async () => {
    const mutex = new WriteMutex()
    await mutex.acquire()

    let secondAcquired = false
    const p = mutex.acquire().then(() => { secondAcquired = true })
    await sleep(10)
    expect(secondAcquired).toBe(false)
    expect(mutex.queueLength).toBe(1)

    mutex.release()
    await p
    expect(secondAcquired).toBe(true)
  })

  test('serializes multiple acquirers', async () => {
    const mutex = new WriteMutex()
    const order: number[] = []

    async function task(id: number) {
      await mutex.acquire()
      order.push(id)
      await sleep(10)
      mutex.release()
    }

    await Promise.all([task(1), task(2), task(3)])
    expect(order).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// isConcurrencySafe
// ---------------------------------------------------------------------------

describe('isConcurrencySafe', () => {
  test('read_file is safe', () => {
    expect(isConcurrencySafe('read_file')).toBe(true)
  })

  test('search is safe', () => {
    expect(isConcurrencySafe('search')).toBe(true)
  })

  test('memory_read is safe', () => {
    expect(isConcurrencySafe('memory_read')).toBe(true)
  })

  test('edit_file is NOT safe', () => {
    expect(isConcurrencySafe('edit_file')).toBe(false)
  })

  test('write_file is NOT safe', () => {
    expect(isConcurrencySafe('write_file')).toBe(false)
  })

  test('exec is NOT safe', () => {
    expect(isConcurrencySafe('exec')).toBe(false)
  })

  test('unknown tools default to NOT safe (treated as mutating)', () => {
    expect(isConcurrencySafe('definitely_not_a_real_tool')).toBe(false)
  })

  test('all registered safe tools return true', () => {
    for (const name of CONCURRENT_SAFE_TOOLS) {
      expect(isConcurrencySafe(name)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// partitionToolCalls
// ---------------------------------------------------------------------------

describe('partitionToolCalls', () => {
  test('empty input returns empty', () => {
    expect(partitionToolCalls([])).toEqual([])
  })

  test('all reads form a single concurrent batch', () => {
    const calls = [
      { name: 'read_file', id: '1', input: {} },
      { name: 'search', id: '2', input: {} },
      { name: 'memory_read', id: '3', input: {} },
    ]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(true)
    expect(batches[0].calls).toHaveLength(3)
  })

  test('all writes form individual serial batches', () => {
    const calls = [
      { name: 'edit_file', id: '1', input: {} },
      { name: 'write_file', id: '2', input: {} },
      { name: 'exec', id: '3', input: {} },
    ]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(3)
    expect(batches.every(b => !b.concurrent)).toBe(true)
    expect(batches.every(b => b.calls.length === 1)).toBe(true)
  })

  test('mixed reads and writes partition correctly', () => {
    const calls = [
      { name: 'read_file', id: '1', input: {} },
      { name: 'read_file', id: '2', input: {} },
      { name: 'edit_file', id: '3', input: {} },
      { name: 'read_file', id: '4', input: {} },
      { name: 'write_file', id: '5', input: {} },
    ]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(4)
    expect(batches[0]).toEqual({ concurrent: true, calls: [calls[0], calls[1]] })
    expect(batches[1]).toEqual({ concurrent: false, calls: [calls[2]] })
    expect(batches[2]).toEqual({ concurrent: true, calls: [calls[3]] })
    expect(batches[3]).toEqual({ concurrent: false, calls: [calls[4]] })
  })

  test('single read returns one concurrent batch', () => {
    const calls = [{ name: 'read_file', id: '1', input: {} }]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(true)
  })

  test('single write returns one serial batch', () => {
    const calls = [{ name: 'exec', id: '1', input: {} }]
    const batches = partitionToolCalls(calls)
    expect(batches).toHaveLength(1)
    expect(batches[0].concurrent).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// wrapToolsWithOrchestration
// ---------------------------------------------------------------------------

describe('wrapToolsWithOrchestration', () => {
  test('returns wrapped tools and orchestration state', () => {
    const tools = [makeTool('read_file'), makeTool('edit_file')]
    const { tools: wrapped, state } = wrapToolsWithOrchestration(tools)

    expect(wrapped).toHaveLength(2)
    expect(state.semaphore).toBeDefined()
    expect(state.writeMutex).toBeDefined()
  })

  test('preserves tool names and metadata', () => {
    const tools = [makeTool('read_file'), makeTool('edit_file')]
    const { tools: wrapped } = wrapToolsWithOrchestration(tools)

    expect(wrapped[0].name).toBe('read_file')
    expect(wrapped[0].label).toBe('read_file')
    expect(wrapped[1].name).toBe('edit_file')
    expect(wrapped[1].label).toBe('edit_file')
  })

  test('wrapped tools produce correct results', async () => {
    const tools = [makeTool('read_file'), makeTool('edit_file')]
    const { tools: wrapped } = wrapToolsWithOrchestration(tools)

    const r1 = await wrapped[0].execute('t1', {})
    expect(r1.details).toEqual({ name: 'read_file' })

    const r2 = await wrapped[1].execute('t2', {})
    expect(r2.details).toEqual({ name: 'edit_file' })
  })

  test('respects maxConcurrency option', () => {
    const tools = [makeTool('read_file')]
    const { state } = wrapToolsWithOrchestration(tools, { maxConcurrency: 5 })
    expect(state.semaphore.available).toBe(5)
  })

  test('default maxConcurrency is 10', () => {
    const tools = [makeTool('read_file')]
    const { state } = wrapToolsWithOrchestration(tools)
    expect(state.semaphore.available).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Concurrency behavior integration tests
// ---------------------------------------------------------------------------

describe('Concurrency behavior', () => {
  test('read-only tools run in parallel', async () => {
    const log: string[] = []
    const tools = [
      makeTimingTool('read_file', log, 50),
      makeTimingTool('grep', log, 50),
      makeTimingTool('ls', log, 50),
    ]
    const { tools: wrapped } = wrapToolsWithOrchestration(tools)

    const start = Date.now()
    await Promise.all([
      wrapped[0].execute('t1', {}),
      wrapped[1].execute('t2', {}),
      wrapped[2].execute('t3', {}),
    ])
    const elapsed = Date.now() - start

    // All 3 should start before any end (parallel execution)
    const startIndices = log
      .map((entry, i) => entry.startsWith('start:') ? i : -1)
      .filter(i => i >= 0)
    const endIndices = log
      .map((entry, i) => entry.startsWith('end:') ? i : -1)
      .filter(i => i >= 0)

    // At least 2 of the 3 tools should start before the first one ends
    expect(startIndices.filter(si => si < endIndices[0]).length).toBeGreaterThanOrEqual(2)

    // Total time should be ~50ms (parallel), not ~150ms (serial)
    expect(elapsed).toBeLessThan(120)
  })

  test('write tools are serialized (run one at a time)', async () => {
    const log: string[] = []
    const tools = [
      makeTimingTool('edit_file', log, 30),
      makeTimingTool('write_file', log, 30),
      makeTimingTool('exec', log, 30),
    ]
    const { tools: wrapped } = wrapToolsWithOrchestration(tools)

    await Promise.all([
      wrapped[0].execute('t1', {}),
      wrapped[1].execute('t2', {}),
      wrapped[2].execute('t3', {}),
    ])

    // Each write tool should start AFTER the previous one ends
    // Pattern: start:A, end:A, start:B, end:B, start:C, end:C
    expect(log).toHaveLength(6)
    for (let i = 0; i < 3; i++) {
      expect(log[i * 2]).toMatch(/^start:/)
      expect(log[i * 2 + 1]).toMatch(/^end:/)
    }

    // Verify no overlapping: each start comes after previous end
    for (let i = 1; i < 3; i++) {
      const prevEnd = log[i * 2 - 1]
      const curStart = log[i * 2]
      expect(prevEnd).toMatch(/^end:/)
      expect(curStart).toMatch(/^start:/)
    }
  })

  test('reads proceed while writes are queued', async () => {
    const log: string[] = []
    const editTool = makeTimingTool('edit_file', log, 60)
    const readTool = makeTimingTool('read_file', log, 20)
    const { tools: wrapped } = wrapToolsWithOrchestration([editTool, readTool])

    const start = Date.now()
    // Launch edit (slow) and read (fast) concurrently
    await Promise.all([
      wrapped[0].execute('t1', {}),
      wrapped[1].execute('t2', {}),
    ])

    // Read should start and finish while edit is also running
    // (read doesn't need write mutex)
    const readStart = log.indexOf('start:read_file')
    const readEnd = log.indexOf('end:read_file')
    expect(readStart).toBeGreaterThanOrEqual(0)
    expect(readEnd).toBeGreaterThan(readStart)

    // Both should have completed
    expect(log.filter(e => e.startsWith('end:')).length).toBe(2)
  })

  test('semaphore limits total concurrency', async () => {
    const log: string[] = []
    const tools = Array.from({ length: 6 }, (_, i) =>
      makeTimingTool(`read_file`, log, 30),
    )
    // Cap at 3 concurrent
    const { tools: wrapped } = wrapToolsWithOrchestration(tools, { maxConcurrency: 3 })

    const start = Date.now()
    await Promise.all(
      wrapped.map((t, i) => t.execute(`t${i}`, {})),
    )
    const elapsed = Date.now() - start

    // 6 tools at max 3 concurrent with 30ms each = ~60ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(50) // some tolerance
    // But less than 6 * 30 = 180ms (which would be fully serial)
    expect(elapsed).toBeLessThan(150)
  })

  test('write tools respect semaphore AND write mutex', async () => {
    const log: string[] = []
    const tools = [
      makeTimingTool('edit_file', log, 20),
      makeTimingTool('write_file', log, 20),
    ]
    const { tools: wrapped, state } = wrapToolsWithOrchestration(tools, { maxConcurrency: 1 })

    const start = Date.now()
    await Promise.all([
      wrapped[0].execute('t1', {}),
      wrapped[1].execute('t2', {}),
    ])
    const elapsed = Date.now() - start

    // With maxConcurrency=1 + writeMutex, both should be fully serial
    expect(elapsed).toBeGreaterThanOrEqual(35) // ~40ms for 2 * 20ms
    expect(log[0]).toMatch(/^start:/)
    expect(log[1]).toMatch(/^end:/)
    expect(log[2]).toMatch(/^start:/)
    expect(log[3]).toMatch(/^end:/)
  })

  test('error in tool still releases locks', async () => {
    const errorTool: AgentTool = {
      name: 'edit_file',
      description: 'Failing tool',
      label: 'edit',
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error('boom')
      },
    }
    const normalTool = makeTool('write_file')

    const { tools: wrapped, state } = wrapToolsWithOrchestration([errorTool, normalTool])

    // First tool throws — second should still be able to acquire locks
    try { await wrapped[0].execute('t1', {}) } catch {}

    // Verify locks are released
    expect(state.writeMutex.isLocked).toBe(false)

    // Second tool should work fine
    const result = await wrapped[1].execute('t2', {})
    expect(result.details).toEqual({ name: 'write_file' })
  })
})

// ---------------------------------------------------------------------------
// Dynamic proxy behavior (MCP hot-add scenario)
// ---------------------------------------------------------------------------

describe('Dynamic proxy preservation', () => {
  /**
   * Simulates the gateway's tool Proxy: a base array of static tools that
   * dynamically merges in "live" tools from a mutable source on every access.
   */
  function createDynamicToolsProxy(
    staticTools: AgentTool[],
    liveToolSource: { tools: AgentTool[] },
  ): AgentTool[] {
    const staticNames = new Set(staticTools.map(t => t.name))
    return new Proxy(staticTools, {
      get(target, prop, receiver) {
        if (prop === 'find' || prop === 'filter' || prop === 'map' ||
            prop === 'forEach' || prop === 'some' || prop === 'every' ||
            prop === Symbol.iterator || prop === 'length' ||
            prop === 'slice' || prop === 'concat' || prop === 'includes') {
          const live = liveToolSource.tools.filter(t => !staticNames.has(t.name))
          const merged = live.length > 0 ? [...target, ...live] : target
          if (prop === 'length') return merged.length
          if (prop === Symbol.iterator) return merged[Symbol.iterator].bind(merged)
          return (merged as any)[prop].bind(merged)
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as AgentTool[]
  }

  test('tools added after wrapping are visible via find()', () => {
    const staticTools = [makeTool('read_file'), makeTool('edit_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    // Initially only static tools
    expect(wrapped.length).toBe(2)
    expect(wrapped.find(t => t.name === 'read_file')).toBeDefined()
    expect(wrapped.find(t => t.name === 'mcp_airbnb_search')).toBeUndefined()

    // Simulate mcp_install adding a new tool mid-turn
    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))

    // The new tool should now be visible through the orchestrated proxy
    expect(wrapped.length).toBe(3)
    const found = wrapped.find(t => t.name === 'mcp_airbnb_search')
    expect(found).toBeDefined()
    expect(found!.name).toBe('mcp_airbnb_search')
  })

  test('dynamically added tools are properly orchestration-wrapped', async () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped, state } = wrapToolsWithOrchestration(dynamicProxy, { maxConcurrency: 2 })

    // Add an MCP tool
    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))

    // Execute the dynamically added tool
    const tool = wrapped.find(t => t.name === 'mcp_airbnb_search')!
    const result = await tool.execute('t1', {})
    expect(result.details).toEqual({ name: 'mcp_airbnb_search' })

    // Verify the semaphore was used (acquired and released)
    expect(state.semaphore.available).toBe(2)
  })

  test('dynamically added write tools acquire write mutex', async () => {
    const log: string[] = []
    const staticTools = [makeTimingTool('read_file', log, 10)]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped, state } = wrapToolsWithOrchestration(dynamicProxy)

    // Add a write tool (not in CONCURRENT_SAFE_TOOLS)
    liveToolSource.tools.push(makeTimingTool('mcp_db_write', log, 20))

    // Execute both concurrently
    const readTool = wrapped.find(t => t.name === 'read_file')!
    const writeTool = wrapped.find(t => t.name === 'mcp_db_write')!

    await Promise.all([
      writeTool.execute('t1', {}),
      readTool.execute('t2', {}),
    ])

    // Both should complete
    expect(log.filter(e => e.startsWith('end:')).length).toBe(2)
    // Locks released
    expect(state.writeMutex.isLocked).toBe(false)
  })

  test('multiple tools added at different times are all visible', () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    expect(wrapped.length).toBe(1)

    // First MCP install
    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))
    expect(wrapped.length).toBe(2)

    // Second MCP install
    liveToolSource.tools.push(makeTool('mcp_stripe_create_payment'))
    expect(wrapped.length).toBe(3)

    // All tools findable
    expect(wrapped.find(t => t.name === 'read_file')).toBeDefined()
    expect(wrapped.find(t => t.name === 'mcp_airbnb_search')).toBeDefined()
    expect(wrapped.find(t => t.name === 'mcp_stripe_create_payment')).toBeDefined()
  })

  test('removed tools disappear from wrapped proxy', () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [makeTool('mcp_airbnb_search')] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    expect(wrapped.length).toBe(2)
    expect(wrapped.find(t => t.name === 'mcp_airbnb_search')).toBeDefined()

    // Simulate mcp_uninstall
    liveToolSource.tools = []
    expect(wrapped.length).toBe(1)
    expect(wrapped.find(t => t.name === 'mcp_airbnb_search')).toBeUndefined()
  })

  test('iteration via for...of sees dynamic tools', () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))

    const names: string[] = []
    for (const t of wrapped) {
      names.push(t.name)
    }
    expect(names).toContain('read_file')
    expect(names).toContain('mcp_airbnb_search')
    expect(names).toHaveLength(2)
  })

  test('filter() sees dynamic tools', () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))

    const mcpTools = wrapped.filter(t => t.name.startsWith('mcp_'))
    expect(mcpTools).toHaveLength(1)
    expect(mcpTools[0].name).toBe('mcp_airbnb_search')
  })

  test('numeric index access sees dynamic tools', () => {
    const staticTools = [makeTool('read_file')]
    const liveToolSource = { tools: [] as AgentTool[] }
    const dynamicProxy = createDynamicToolsProxy(staticTools, liveToolSource)

    const { tools: wrapped } = wrapToolsWithOrchestration(dynamicProxy)

    liveToolSource.tools.push(makeTool('mcp_airbnb_search'))

    expect(wrapped[0].name).toBe('read_file')
    expect(wrapped[1].name).toBe('mcp_airbnb_search')
    expect(wrapped[2]).toBeUndefined()
  })
})

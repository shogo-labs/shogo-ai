// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for the terminal module — tests multiple
 * components working together across module boundaries.
 *
 * Pipelines tested:
 *   1. Context injection: Tracker → ContextAggregator → formatContextMessage
 *   2. Command execution: Executor → Bridge → Tracker events → Result
 *   3. Signal/interrupt: Bridge → sendCommand → interruptCommand → SIGINT
 *   4. Streaming: Tracker data → OutputStreamer → callback
 *   5. Store lifecycle: TerminalContextStore publish → enrichMessage → withdraw
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { Osc633Tracker } from '../osc633-tracker'
import { AgentTerminalBridge, type CommandResult } from '../agent-terminal-bridge'
import { TerminalCommandExecutor } from '../terminal-command-executor'
import { ContextAggregator, serializeContext, formatContextMessage } from '../context-aggregator'
import { OutputStreamer, stripAnsi } from '../output-streamer'
import { createTerminalContextStore } from '../terminal-context-store'
import { getTerminalStatus } from '../agent-terminal-panel'
import type { AgentTerminalInstance } from '../agent-terminal-factory'

// ─── helpers ────────────────────────────────────────────────────────────

function feedRaw(tracker: Osc633Tracker, s: string) {
  const enc = new TextEncoder().encode(s)
  const { OscDecoder } = require('@shogo/pty-core')
  const decoder = new OscDecoder()
  const { events } = decoder.feed(enc)
  tracker.feedAll(events)
}

/** Simulate a full command cycle: A → B → E(cmd) → C → D */
function simulateCommand(tracker: Osc633Tracker, cmd: string, exitCode: number, cwd?: string) {
  if (cwd) feedRaw(tracker, `\x1b]633;P;Cwd=${cwd}\x07`)
  feedRaw(tracker, '\x1b]633;A\x07')
  feedRaw(tracker, '\x1b]633;B\x07')
  feedRaw(tracker, `\x1b]633;E;${cmd}\x07`)
  feedRaw(tracker, '\x1b]633;C\x07')
  feedRaw(tracker, `\x1b]633;D;${exitCode}\x07`)
}

// ─── Pipeline 1: Context injection ──────────────────────────────────────

describe('Pipeline: Context injection', () => {
  it('collects terminal commands and formats into context message', async () => {
    const tracker = new Osc633Tracker()

    // Simulate some terminal commands
    simulateCommand(tracker, 'npm test', 0, '/project')
    simulateCommand(tracker, 'git status', 1, '/project')

    const aggregator = new ContextAggregator({
      tracker,
      editor: { getActiveFile: async () => null },
      git: { getStatus: async () => null },
      diagnostics: { getDiagnostics: async () => [] },
    })

    const context = await aggregator.collect()
    expect(context.sources.length).toBeGreaterThan(0)

    const serialized = serializeContext(context)
    expect(serialized).toContain('npm test')
    expect(serialized).toContain('git status')

    const message = formatContextMessage(serialized, 'fix the failing test')
    expect(message).toContain('CONTEXT')
    expect(message).toContain('fix the failing test')
  })

  it('returns original message when no context available', async () => {
    const tracker = new Osc633Tracker()

    const aggregator = new ContextAggregator({
      tracker,
      editor: { getActiveFile: async () => null },
      git: { getStatus: async () => null },
      diagnostics: { getDiagnostics: async () => [] },
    })

    const context = await aggregator.collect()
    expect(context.sources.length).toBe(0)

    const serialized = serializeContext(context)
    const message = formatContextMessage(serialized, 'hello')
    expect(message).toContain('hello')
  })
})

// ─── Pipeline 2: Command execution ──────────────────────────────────────

describe('Pipeline: Command execution', () => {
  it('executor → bridge → tracker → result', async () => {
    const tracker = new Osc633Tracker()
    const sent: string[] = []
    const bridge = new AgentTerminalBridge({
      tracker,
      send: (data) => sent.push(data),
      commandTimeoutMs: 5000,
    })

    const executor = new TerminalCommandExecutor({
      tracker,
      bridge,
      defaultTimeoutMs: 5000,
    })

    expect(executor.isReady()).toBe(true)
    expect(executor.queueLength()).toBe(0)

    // Start execution (will wait for tracker events)
    const resultPromise = executor.execute({
      requestId: 'req_1',
      command: 'echo hello',
    })

    // Simulate terminal processing
    simulateCommand(tracker, 'echo hello', 0, '/tmp')

    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.requestId).toBe('req_1')
    expect(result.cwd).toBe('/tmp')
    expect(result.timedOut).toBe(false)
    bridge.dispose()
  })

  it('executor queues when maxConcurrent reached', async () => {
    const tracker = new Osc633Tracker()
    const bridge = new AgentTerminalBridge({
      tracker,
      send: () => {},
      commandTimeoutMs: 5000,
    })

    const executor = new TerminalCommandExecutor({
      tracker,
      bridge,
      defaultTimeoutMs: 5000,
      maxConcurrent: 1,
    })

    // First command starts
    const p1 = executor.execute({ requestId: 'req_1', command: 'cmd1' })
    simulateCommand(tracker, 'cmd1', 0)

    // Second command should be queued
    const p2 = executor.execute({ requestId: 'req_2', command: 'cmd2' })
    expect(executor.queueLength()).toBe(1)

    await p1
    // Now queue drains
    simulateCommand(tracker, 'cmd2', 0)

    const r2 = await p2
    expect(r2.ok).toBe(true)
    expect(executor.queueLength()).toBe(0)
    bridge.dispose()
  })
})

// ─── Pipeline 3: Signal / interrupt ─────────────────────────────────────

describe('Pipeline: Signal / interrupt', () => {
  it('sendCommand → interruptCommand → SIGINT → resolved', async () => {
    const tracker = new Osc633Tracker()
    const signals: string[] = []
    const bridge = new AgentTerminalBridge({
      tracker,
      send: () => {},
      signal: (sig) => signals.push(sig),
      commandTimeoutMs: 5000,
    })

    const executor = new TerminalCommandExecutor({
      tracker,
      bridge,
      defaultTimeoutMs: 5000,
    })

    // Start long-running command
    const resultPromise = executor.execute({
      requestId: 'req_1',
      command: 'sleep 999',
    })

    // Simulate command-started
    feedRaw(tracker, '\x1b]633;A\x07')
    feedRaw(tracker, '\x1b]633;B\x07')
    feedRaw(tracker, '\x1b]633;C\x07')

    // Interrupt via executor
    executor.interruptCommand()
    expect(signals).toContain('INT')

    // Simulate SIGINT causing exit 130
    feedRaw(tracker, '\x1b]633;D;130\x07')

    const result = await resultPromise
    expect(result.exitCode).toBe(130)
    expect(result.timedOut).toBe(false)
    bridge.dispose()
  })

  it('sendSignal delegates through the full chain', () => {
    const tracker = new Osc633Tracker()
    const signals: string[] = []
    const bridge = new AgentTerminalBridge({
      tracker,
      send: () => {},
      signal: (sig) => signals.push(sig),
    })

    const executor = new TerminalCommandExecutor({ tracker, bridge })

    executor.sendSignal('TERM')
    expect(signals).toEqual(['TERM'])

    executor.sendSignal('INT')
    expect(signals).toEqual(['TERM', 'INT'])
    bridge.dispose()
  })
})

// ─── Pipeline 4: Streaming ──────────────────────────────────────────────

describe('Pipeline: Output streaming', () => {
  it('feeds output → debounces → flushes to callback', async () => {
    const chunks: string[] = []
    const tracker = new Osc633Tracker()
    const streamer = new OutputStreamer({
      tracker,
      onData: (chunk) => chunks.push(chunk),
      debounceMs: 50,
      thresholdChars: 100,
    })

    streamer.start()

    // Simulate terminal output
    streamer.feedOutput('\x1b[32mCompiling...\x1b[0m ')
    streamer.feedOutput('done\n')
    streamer.feedOutput('\x1b[1mTests:\x1b[0m 17 passed\n')

    expect(chunks).toHaveLength(0) // debouncing

    await new Promise((r) => setTimeout(r, 80))

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('')).toContain('Compiling...')
    expect(chunks.join('')).toContain('Tests:')
    expect(chunks.join('')).not.toContain('\x1b') // ANSI stripped

    streamer.dispose()
  })

  it('streamer + stripAnsi pipeline', () => {
    const input = '\x1b[31mError:\x1b[0m Cannot find module\x1b[2K'
    const stripped = stripAnsi(input)
    expect(stripped).toBe('Error: Cannot find module')
  })
})

// ─── Pipeline 5: Store lifecycle ────────────────────────────────────────

describe('Pipeline: TerminalContextStore lifecycle', () => {
  it('publish → enrichMessage → withdraw → no-op', async () => {
    const store = createTerminalContextStore()
    const tracker = new Osc633Tracker()

    // Initially not ready
    expect(store.isReady()).toBe(false)
    expect(store.current()).toBeNull()

    // Create mock bridge and publish
    const bridge = new AgentTerminalBridge({
      tracker,
      send: () => {},
    })

    store.publish({ tracker, bridge, cwd: '/project', publishedAt: Date.now() })
    expect(store.isReady()).toBe(true)

    // enrichMessage should work
    simulateCommand(tracker, 'npm test', 0, '/project')
    const enriched = await store.enrichMessage('help me fix tests')
    expect(enriched).toContain('CONTEXT')
    expect(enriched).toContain('help me fix tests')

    // Recent commands should be available
    const cmds = store.getRecentCommands(5)
    expect(cmds.length).toBe(1)
    expect(cmds[0].commandLine).toContain('npm test')

    // Withdraw
    store.withdraw()
    expect(store.isReady()).toBe(false)

    // After withdraw, enrichMessage is a no-op
    const after = await store.enrichMessage('still here')
    expect(after).toBe('still here')

    bridge.dispose()
  })

  it('subscriber receives publish and withdraw events', () => {
    const store = createTerminalContextStore()
    const events: string[] = []

    const unsub = store.subscribe((snapshot) => {
      events.push(snapshot ? 'publish' : 'withdraw')
    })

    const tracker = new Osc633Tracker()
    const bridge = new AgentTerminalBridge({ tracker, send: () => {} })

    store.publish({ tracker, bridge, cwd: '/tmp', publishedAt: Date.now() })
    store.withdraw()

    expect(events).toEqual(['publish', 'withdraw'])

    unsub()
    bridge.dispose()
  })
})

// ─── Pipeline 6: AgentTerminalPanel status ──────────────────────────────

describe('Pipeline: Agent terminal panel status', () => {
  it('status mapping through full lifecycle', () => {
    const instance = {
      id: 'term_1',
      tracker: null,
      bridge: null,
      cwd: '/tmp',
      alive: true,
      command: 'npm test',
      commandResult: null,
      elapsedMs: 0,
      disposed: false,
      sendCommand: async () => ({ command: '', exitCode: 0, cwd: null, durationMs: 0, timedOut: false }),
      sendCommandBackground: () => null,
      getRecentCommands: () => [],
      dispose: async () => {},
    } as unknown as AgentTerminalInstance

    // Initially running
    expect(getTerminalStatus(instance)).toBe('running')

    // Command completes
    instance.commandResult = { command: 'npm test', exitCode: 0, cwd: '/tmp', durationMs: 1234, timedOut: false }
    expect(getTerminalStatus(instance)).toBe('completed')

    // Reset for failed test
    instance.commandResult = { command: 'npm test', exitCode: 1, cwd: '/tmp', durationMs: 500, timedOut: false }
    expect(getTerminalStatus(instance)).toBe('failed')

    // Disposed overrides everything
    instance.disposed = true
    expect(getTerminalStatus(instance)).toBe('disposed')
  })
})

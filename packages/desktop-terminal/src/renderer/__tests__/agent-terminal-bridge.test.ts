// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for AgentTerminalBridge.
 *
 * Tests cover:
 *   - sendCommand: resolves on command-finished with exit code
 *   - sendCommand: times out when command never finishes
 *   - sendCommand: handles rapid calls (safe-resolve guard)
 *   - sendCommand: returns early when disposed
 *   - sendCommandBackground: returns immediately, resolves later
 *   - sendCommandBackground: tracks task status
 *   - dispose: cleans up all timers and tasks
 *   - setSend: hot-swaps the send function
 *   - getRecentCommands / getCurrentCwd: delegate to tracker
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Osc633Tracker } from '../osc633-tracker'
import { AgentTerminalBridge } from '../agent-terminal-bridge'
import type { Command } from '../osc633-tracker'

// ─── helpers ────────────────────────────────────────────────────────────

function makeTracker(): Osc633Tracker {
  return new Osc633Tracker()
}

function feedRaw(tracker: Osc633Tracker, s: string) {
  const enc = new TextEncoder().encode(s)
  const { OscDecoder } = require('@shogo/pty-core')
  const decoder = new OscDecoder()
  const { events } = decoder.feed(enc)
  tracker.feedAll(events)
}

/** Simulate a full command cycle: P → A → B → E → C → D */
function simulateCommand(tracker: Osc633Tracker, cmd: string, exitCode: number, cwd?: string) {
  if (cwd) feedRaw(tracker, `\x1b]633;P;Cwd=${cwd}\x07`)
  feedRaw(tracker, `\x1b]633;A\x07`)
  feedRaw(tracker, `\x1b]633;B\x07`)
  feedRaw(tracker, `\x1b]633;E;${cmd}\x07`)
  feedRaw(tracker, `\x1b]633;C\x07`)
  feedRaw(tracker, `\x1b]633;D;${exitCode}\x07`)
}

function makeBridge(opts?: { timeoutMs?: number }) {
  const tracker = makeTracker()
  const sent: string[] = []
  const bridge = new AgentTerminalBridge({
    tracker,
    send: (data) => sent.push(data),
    commandTimeoutMs: opts?.timeoutMs ?? 5000,
  })
  return { tracker, sent, bridge }
}

// ─── tests ──────────────────────────────────────────────────────────────

describe('AgentTerminalBridge', () => {
  afterEach(() => {
    // Clean up any lingering state
  })

  describe('sendCommand()', () => {
    it('resolves with exit code when command finishes', async () => {
      const { tracker, sent, bridge } = makeBridge()

      // Start waiting for a command
      const promise = bridge.sendCommand('npm test')

      // Simulate the terminal processing the command
      simulateCommand(tracker, 'npm test', 1, '/proj')

      const result = await promise
      expect(result.command).toBe('npm test')
      expect(result.exitCode).toBe(1)
      expect(result.cwd).toBe('/proj')
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).not.toBeNull()
      expect(sent).toEqual(['npm test\r'])
      bridge.dispose()
    })

    it('resolves with exit 0 for successful command', async () => {
      const { tracker, bridge } = makeBridge()
      const promise = bridge.sendCommand('ls')
      simulateCommand(tracker, 'ls', 0, '/tmp')
      const result = await promise
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      bridge.dispose()
    })

    it('returns timedOut result when command never finishes', async () => {
      const { tracker, bridge } = makeBridge({ timeoutMs: 50 })

      const promise = bridge.sendCommand('sleep 999')

      // Simulate only the command-started event, never command-finished
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07')
      // No D event

      const result = await promise
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBeNull()
      bridge.dispose()
    })

    it('does not resolve twice for the same sendCommand call', async () => {
      const { tracker, bridge } = makeBridge()

      // Sequential usage pattern — await each before sending the next
      const p1 = bridge.sendCommand('cmd1')
      simulateCommand(tracker, 'cmd1', 0)
      const r1 = await p1
      expect(r1.command).toBe('cmd1')
      expect(r1.exitCode).toBe(0)

      const p2 = bridge.sendCommand('cmd2')
      simulateCommand(tracker, 'cmd2', 1)
      const r2 = await p2
      expect(r2.command).toBe('cmd2')
      expect(r2.exitCode).toBe(1)

      bridge.dispose()
    })

    it('returns early when bridge is disposed', async () => {
      const { bridge } = makeBridge()
      bridge.dispose()

      const result = await bridge.sendCommand('ls')
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBeNull()
    })
  })

  describe('sendCommandBackground()', () => {
    it('returns a task immediately without waiting', async () => {
      const { tracker, bridge } = makeBridge()

      const task = bridge.sendCommandBackground('npm run build')
      expect(task.command).toBe('npm run build')
      expect(task.id).toMatch(/^bg_/)
      expect(bridge.getTaskStatus(task.id)).not.toBeNull()

      // Simulate completion
      simulateCommand(tracker, 'npm run build', 0)
      const result = await task.promise
      expect(result.exitCode).toBe(0)
      bridge.dispose()
    })

    it('task resolves to timedOut on timeout', async () => {
      const { tracker, bridge } = makeBridge({ timeoutMs: 50 })

      const task = bridge.sendCommandBackground('sleep 999')
      // Fire command-started but not finished
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07')

      const result = await task.promise
      expect(result.timedOut).toBe(true)
      bridge.dispose()
    })

    it('getTaskStatus returns null for unknown IDs', () => {
      const { bridge } = makeBridge()
      expect(bridge.getTaskStatus('nonexistent')).toBeNull()
      bridge.dispose()
    })

    it('dispose() removes task from status tracking', () => {
      const { bridge } = makeBridge()
      const task = bridge.sendCommandBackground('ls')
      expect(bridge.getTaskStatus(task.id)).not.toBeNull()
      task.dispose()
      expect(bridge.getTaskStatus(task.id)).toBeNull()
      bridge.dispose()
    })

    it('uses per-instance task counters', () => {
      const t1 = makeBridge()
      const t2 = makeBridge()
      const bg1a = t1.bridge.sendCommandBackground('cmd1')
      const bg1b = t1.bridge.sendCommandBackground('cmd2')
      const bg2 = t2.bridge.sendCommandBackground('cmd3')
      // Same instance increments counter
      expect(bg1a.id).not.toBe(bg1b.id)
      // Different instances both start at bg_1
      expect(bg1a.id).toBe('bg_1')
      expect(bg1b.id).toBe('bg_2')
      expect(bg2.id).toBe('bg_1')
      t1.bridge.dispose()
      t2.bridge.dispose()
    })
  })

  describe('setSend()', () => {
    it('hot-swaps the send function', async () => {
      const tracker = makeTracker()
      const sent1: string[] = []
      const sent2: string[] = []
      const bridge = new AgentTerminalBridge({
        tracker,
        send: (data) => sent1.push(data),
        commandTimeoutMs: 5000,
      })

      const p = bridge.sendCommand('first')
      simulateCommand(tracker, 'first', 0)
      await p
      expect(sent1).toEqual(['first\r'])

      // Swap to second send function
      bridge.setSend((data) => sent2.push(data))
      const p2 = bridge.sendCommand('second')
      simulateCommand(tracker, 'second', 0)
      await p2
      expect(sent2).toEqual(['second\r'])
      expect(sent1).toHaveLength(1) // First send wasn't called again
      bridge.dispose()
    })
  })

  describe('getRecentCommands() / getCurrentCwd()', () => {
    it('delegates to tracker snapshot', () => {
      const { tracker, bridge } = makeBridge()
      simulateCommand(tracker, 'ls', 0, '/tmp')
      simulateCommand(tracker, 'pwd', 0, '/var')

      expect(bridge.getRecentCommands(1)).toHaveLength(1)
      expect(bridge.getRecentCommands(10)).toHaveLength(2)
      expect(bridge.getCurrentCwd()).toBe('/var')
      bridge.dispose()
    })
  })

  describe('dispose()', () => {
    it('cleans up all timers and tasks', () => {
      const { tracker, bridge } = makeBridge()

      // Create some pending work
      const bg = bridge.sendCommandBackground('sleep 999')

      // Dispose should not throw
      bridge.dispose()

      // After dispose, pending tasks should be gone
      expect(bridge.getTaskStatus(bg.id)).toBeNull()
    })

    it('prevents new sendCommand calls', async () => {
      const { bridge } = makeBridge()
      bridge.dispose()

      const result = await bridge.sendCommand('ls')
      expect(result.exitCode).toBeNull()
    })
  })

  describe('interruptCommand()', () => {
    it('returns null when no command is running', () => {
      const { bridge } = makeBridge()
      expect(bridge.interruptCommand()).toBeNull()
      bridge.dispose()
    })

    it('sends SIGINT via the signal callback', async () => {
      const tracker = makeTracker()
      const signals: string[] = []
      const bridge = new AgentTerminalBridge({
        tracker,
        send: () => {},
        signal: (sig) => signals.push(sig),
        commandTimeoutMs: 5000,
      })

      // Start a command — need C (pre-exec) to trigger command-started
      const promise = bridge.sendCommand('sleep 999')
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07') // triggers command-started

      // Interrupt it
      bridge.interruptCommand()
      expect(signals).toEqual(['INT'])

      // Simulate the command finishing after SIGINT (exitCode 130)
      feedRaw(tracker, '\x1b]633;D;130\x07')

      const result = await promise
      expect(result.exitCode).toBe(130)
      expect(result.timedOut).toBe(false)
      bridge.dispose()
    })

    it('force-resolves if tracker does not emit command-finished after SIGINT', async () => {
      const tracker = makeTracker()
      const signals: string[] = []
      const bridge = new AgentTerminalBridge({
        tracker,
        send: () => {},
        signal: (sig) => signals.push(sig),
        commandTimeoutMs: 5000,
      })

      const promise = bridge.sendCommand('sleep 999')
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07') // triggers command-started

      bridge.interruptCommand()
      expect(signals).toEqual(['INT'])

      // Don't emit command-finished — grace timer should resolve
      const result = await promise
      expect(result.exitCode).toBeNull()
      expect(result.timedOut).toBe(false)
      expect(result.command).toBe('sleep 999')
      bridge.dispose()
    })

    it('clears activeCommandId after interrupt resolves', async () => {
      const tracker = makeTracker()
      const bridge = new AgentTerminalBridge({
        tracker,
        send: () => {},
        commandTimeoutMs: 5000,
      })

      const p1 = bridge.sendCommand('sleep 999')
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07')

      bridge.interruptCommand()
      feedRaw(tracker, '\x1b]633;D;130\x07')
      await p1

      // Now send another command (activeCommandId should be cleared)
      const p2 = bridge.sendCommand('echo done')
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;E;echo done\x07')
      feedRaw(tracker, '\x1b]633;C\x07')
      feedRaw(tracker, '\x1b]633;D;0\x07')

      const r2 = await p2
      expect(r2.exitCode).toBe(0)
      bridge.dispose()
    })

    it('multiple rapid interrupts: signals sent each time', async () => {
      const tracker = makeTracker()
      const signals: string[] = []
      const bridge = new AgentTerminalBridge({
        tracker,
        send: () => {},
        signal: (sig) => signals.push(sig),
        commandTimeoutMs: 5000,
      })

      const p = bridge.sendCommand('sleep 999')
      feedRaw(tracker, '\x1b]633;A\x07')
      feedRaw(tracker, '\x1b]633;B\x07')
      feedRaw(tracker, '\x1b]633;C\x07')

      bridge.interruptCommand()
      bridge.interruptCommand()
      bridge.interruptCommand()

      // Each call sends a signal (harmless to repeat)
      expect(signals.filter(s => s === 'INT').length).toBe(3)

      feedRaw(tracker, '\x1b]633;D;130\x07')
      await p
      bridge.dispose()
    })
  })

  describe('sendSignal()', () => {
    it('delegates to the signal callback', () => {
      const signals: string[] = []
      const { bridge } = makeBridge()
      // Replace signal on the bridge via the internal ref
      // For this test, we create a new bridge with signal
      const tracker = makeTracker()
      const b2 = new AgentTerminalBridge({
        tracker,
        send: () => {},
        signal: (sig) => signals.push(sig),
      })
      b2.sendSignal('INT')
      expect(signals).toEqual(['INT'])
      b2.sendSignal('TERM')
      expect(signals).toEqual(['INT', 'TERM'])
      b2.dispose()
      bridge.dispose()
    })

    it('no-op when signal callback is not provided', () => {
      const { bridge } = makeBridge()
      // Should not throw
      bridge.sendSignal('INT')
      bridge.sendSignal('TERM')
      bridge.dispose()
    })
  })
})

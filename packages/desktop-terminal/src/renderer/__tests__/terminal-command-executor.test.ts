// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for TerminalCommandExecutor.
 *
 * Tests cover:
 *   - Basic command execution and result
 *   - CWD change when request.cwd differs from current
 *   - Timeout behavior
 *   - Queue management (maxConcurrent = 1)
 *   - isReady / queueLength / getCurrentCwd
 *   - Error handling
 *   - Factory function
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { TerminalCommandExecutor, createTerminalCommandExecutor } from '../terminal-command-executor'
import type { Osc633Tracker } from '../osc633-tracker'
import type { AgentTerminalBridge, CommandResult } from '../agent-terminal-bridge'

function createMockTracker(cwd?: string): Osc633Tracker {
  return {
    snapshot: () => ({ cwd: cwd ?? '/home/user', commands: [] }),
    on: () => () => {},
  } as unknown as Osc633Tracker
}

function createMockBridge(opts?: {
  onSend?: (cmd: string) => void
  timeoutMs?: number
}): AgentTerminalBridge {
  const onSend = opts?.onSend
  return {
    sendCommand: async (cmd: string): Promise<CommandResult> => {
      onSend?.(cmd)
      return {
        command: cmd,
        exitCode: 0,
        cwd: '/home/user',
        durationMs: 50,
        timedOut: false,
      }
    },
    commandTimeoutMs: opts?.timeoutMs ?? 120_000,
  } as unknown as AgentTerminalBridge
}

describe('TerminalCommandExecutor', () => {
  let tracker: Osc633Tracker
  let bridge: AgentTerminalBridge

  beforeEach(() => {
    tracker = createMockTracker()
    bridge = createMockBridge()
  })

  test('basic command execution', async () => {
    const executor = new TerminalCommandExecutor({ tracker, bridge })
    const result = await executor.execute({
      requestId: 'req-1',
      command: 'echo hello',
    })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.requestId).toBe('req-1')
    expect(result.timedOut).toBe(false)
  })

  test('isReady returns true when bridge is available', () => {
    const executor = new TerminalCommandExecutor({ tracker, bridge })
    expect(executor.isReady()).toBe(true)
  })

  test('getCurrentCwd returns tracker cwd', () => {
    tracker = createMockTracker('/my/special/cwd')
    const executor = new TerminalCommandExecutor({ tracker, bridge })
    expect(executor.getCurrentCwd()).toBe('/my/special/cwd')
  })

  test('queueLength is 0 when idle', () => {
    const executor = new TerminalCommandExecutor({ tracker, bridge })
    expect(executor.queueLength()).toBe(0)
  })

  test('cd is sent before command when cwd differs', async () => {
    const sent: string[] = []
    bridge = createMockBridge({ onSend: (cmd) => sent.push(cmd) })
    const executor = new TerminalCommandExecutor({ tracker, bridge })

    await executor.execute({
      requestId: 'req-1',
      command: 'ls',
      cwd: '/different/dir',
    })

    expect(sent[0]).toContain('cd')
    expect(sent[0]).toContain('/different/dir')
    expect(sent[1]).toBe('ls')
  })

  test('cd is NOT sent when cwd matches current', async () => {
    const sent: string[] = []
    bridge = createMockBridge({ onSend: (cmd) => sent.push(cmd) })
    const executor = new TerminalCommandExecutor({ tracker, bridge })

    await executor.execute({
      requestId: 'req-1',
      command: 'ls',
      cwd: '/home/user', // same as tracker cwd
    })

    expect(sent).toEqual(['ls'])
  })

  test('queue serializes commands when maxConcurrent=1', async () => {
    const order: string[] = []
    let resolvers: Array<() => void> = []

    bridge = {
      sendCommand: (cmd: string) => {
        order.push(`start:${cmd}`)
        return new Promise<CommandResult>((resolve) => {
          resolvers.push(() => {
            order.push(`end:${cmd}`)
            resolve({
              command: cmd,
              exitCode: 0,
              cwd: '/home/user',
              durationMs: 10,
              timedOut: false,
            })
          })
        })
      },
      commandTimeoutMs: 120_000,
    } as unknown as AgentTerminalBridge

    const executor = new TerminalCommandExecutor({ tracker, bridge, maxConcurrent: 1 })

    // Fire two commands — second should queue
    const p1 = executor.execute({ requestId: 'r1', command: 'cmd1' })
    const p2 = executor.execute({ requestId: 'r2', command: 'cmd2' })

    expect(executor.queueLength()).toBe(1)

    // Resolve first
    resolvers[0]()
    await p1

    // Now second should start
    expect(executor.queueLength()).toBe(0)
    resolvers[1]()
    await p2

    expect(order).toEqual(['start:cmd1', 'end:cmd1', 'start:cmd2', 'end:cmd2'])
  })

  test('error in bridge returns ok:false with error message', async () => {
    bridge = {
      sendCommand: async () => { throw new Error('Bridge disconnected') },
      commandTimeoutMs: 120_000,
    } as unknown as AgentTerminalBridge

    const executor = new TerminalCommandExecutor({ tracker, bridge })
    const result = await executor.execute({
      requestId: 'req-err',
      command: 'failing-cmd',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Bridge disconnected')
    expect(result.exitCode).toBeNull()
  })

  test('factory function creates executor', () => {
    const executor = createTerminalCommandExecutor({ tracker, bridge })
    expect(executor).toBeInstanceOf(TerminalCommandExecutor)
    expect(executor.isReady()).toBe(true)
  })
})

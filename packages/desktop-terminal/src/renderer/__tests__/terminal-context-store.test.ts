// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for TerminalContextStore (module-level singleton).
 *
 * Tests cover:
 *   - publish / withdraw lifecycle
 *   - subscribe / unsubscribe notifications
 *   - isReady state transitions
 *   - enrichMessage (context injection)
 *   - getRecentCommands / getCwd
 *   - sendCommand (returns null when not ready, delegates when ready)
 *   - Multiple subscribers
 *   - Publish overwrites previous snapshot
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { createTerminalContextStore } from '../terminal-context-store'
import type { Osc633Tracker, Command } from '../osc633-tracker'
import type { AgentTerminalBridge } from '../agent-terminal-bridge'

function createMockTracker(cwd?: string, commands?: Partial<Command>[]): Osc633Tracker {
  return {
    snapshot: () => ({
      cwd: cwd ?? '/home/user/project',
      commands: (commands ?? []).map((c, i) => ({
        id: c.id ?? i + 1,
        commandLine: c.commandLine ?? `echo test${i}`,
        cwd: c.cwd ?? cwd ?? '/home/user/project',
        exitCode: c.exitCode ?? 0,
        state: c.state ?? 'finished',
        startedAt: c.startedAt ?? Date.now() - 1000,
        finishedAt: c.finishedAt ?? Date.now(),
        startMarker: c.startMarker,
        endMarker: c.endMarker,
        commandLineStartCol: 0,
        commandLineEndCol: 0,
      })),
    }),
    on: () => () => {},
    feed: () => {},
    feedAll: () => {},
  } as unknown as Osc633Tracker
}

function createMockBridge(): AgentTerminalBridge {
  return {
    sendCommand: async (cmd: string) => ({
      command: cmd,
      exitCode: 0,
      cwd: '/home/user/project',
      durationMs: 100,
      timedOut: false,
    }),
    sendCommandBackground: () => null,
    getRecentCommands: () => [],
    getCurrentCwd: () => '/home/user/project',
    getCommandOutput: () => undefined,
    setSend: () => {},
    dispose: () => {},
  } as unknown as AgentTerminalBridge
}

describe('TerminalContextStore', () => {
  let store: ReturnType<typeof createTerminalContextStore>

  beforeEach(() => {
    // Clear global singleton backing store between tests
    delete (globalThis as any).__shogoTerminalContext
    store = createTerminalContextStore()
  })

  test('initially not ready', () => {
    expect(store.isReady()).toBe(false)
    expect(store.current()).toBeNull()
  })

  test('publish makes the store ready', () => {
    const tracker = createMockTracker()
    const bridge = createMockBridge()
    store.publish({ tracker, bridge, cwd: '/project', publishedAt: Date.now() })
    expect(store.isReady()).toBe(true)
    expect(store.current()?.tracker).toBe(tracker)
    expect(store.current()?.bridge).toBe(bridge)
    expect(store.current()?.cwd).toBe('/project')
  })

  test('withdraw makes the store not ready', () => {
    store.publish({ tracker: createMockTracker(), bridge: createMockBridge(), cwd: '/p', publishedAt: Date.now() })
    expect(store.isReady()).toBe(true)
    store.withdraw()
    expect(store.isReady()).toBe(false)
    expect(store.current()).toBeNull()
  })

  test('publish overwrites previous snapshot', () => {
    const t1 = createMockTracker('/dir1')
    const t2 = createMockTracker('/dir2')
    const bridge = createMockBridge()
    store.publish({ tracker: t1, bridge, cwd: '/dir1', publishedAt: 1 })
    store.publish({ tracker: t2, bridge, cwd: '/dir2', publishedAt: 2 })
    expect(store.current()?.cwd).toBe('/dir2')
    expect(store.current()?.publishedAt).toBe(2)
  })

  test('subscribe notifies on publish and withdraw', () => {
    const events: (string | null)[] = []
    store.subscribe((snap) => {
      events.push(snap?.cwd ?? null)
    })

    store.publish({ tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    store.publish({ tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })
    store.withdraw()

    expect(events).toEqual(['/a', '/b', null])
  })

  test('unsubscribe stops notifications', () => {
    const events: string[] = []
    const unsub = store.subscribe((snap) => {
      if (snap) events.push(snap.cwd!)
    })

    store.publish({ tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    unsub()
    store.publish({ tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })

    expect(events).toEqual(['/a'])
  })

  test('getRecentCommands returns commands when ready', () => {
    const tracker = createMockTracker('/p', [
      { id: 1, commandLine: 'ls' },
      { id: 2, commandLine: 'git status' },
    ])
    store.publish({ tracker, bridge: createMockBridge(), cwd: '/p', publishedAt: 1 })

    const cmds = store.getRecentCommands(5)
    expect(cmds).toHaveLength(2)
    expect(cmds[0].commandLine).toBe('ls')
    expect(cmds[1].commandLine).toBe('git status')
  })

  test('getRecentCommands returns empty when not ready', () => {
    expect(store.getRecentCommands()).toEqual([])
  })

  test('getCwd returns cwd when ready', () => {
    store.publish({ tracker: createMockTracker('/my/cwd'), bridge: createMockBridge(), cwd: '/my/cwd', publishedAt: 1 })
    expect(store.getCwd()).toBe('/my/cwd')
  })

  test('getCwd returns null when not ready', () => {
    expect(store.getCwd()).toBeNull()
  })

  test('sendCommand returns null when not ready', async () => {
    const result = await store.sendCommand('ls')
    expect(result).toBeNull()
  })

  test('sendCommand delegates to bridge when ready', async () => {
    const bridge = createMockBridge()
    store.publish({ tracker: createMockTracker(), bridge, cwd: '/p', publishedAt: 1 })
    const result = await store.sendCommand('echo hello')
    expect(result).not.toBeNull()
    expect(result!.command).toBe('echo hello')
    expect(result!.exitCode).toBe(0)
  })

  test('enrichMessage returns original when not ready', async () => {
    const result = await store.enrichMessage('hello world')
    expect(result).toBe('hello world')
  })

  test('enrichMessage returns original when tracker has no commands', async () => {
    const tracker = createMockTracker('/project', [])
    store.publish({ tracker, bridge: createMockBridge(), cwd: '/project', publishedAt: 1 })
    const result = await store.enrichMessage('hello world')
    expect(result).toBe('hello world')
  })

  test('enrichMessage prepends context when tracker has commands', async () => {
    const tracker = createMockTracker('/project', [
      { id: 1, commandLine: 'npm test', exitCode: 1, startedAt: Date.now() - 5000, finishedAt: Date.now() },
    ])
    store.publish({ tracker, bridge: createMockBridge(), cwd: '/project', publishedAt: 1 })
    const result = await store.enrichMessage('fix the tests')
    expect(result).toContain('[CONTEXT — auto-generated')
    expect(result).toContain('npm test')
    expect(result).toContain('fix the tests')
  })

  test('multiple subscribers all get notified', () => {
    const e1: string[] = []
    const e2: string[] = []
    store.subscribe((s) => { if (s) e1.push(s.cwd!) })
    store.subscribe((s) => { if (s) e2.push(s.cwd!) })

    store.publish({ tracker: createMockTracker('/x'), bridge: createMockBridge(), cwd: '/x', publishedAt: 1 })
    expect(e1).toEqual(['/x'])
    expect(e2).toEqual(['/x'])
  })
})

describe('TerminalContextStore — session-keyed (multi-terminal)', () => {
  let store: ReturnType<typeof createTerminalContextStore>

  beforeEach(() => {
    delete (globalThis as any).__shogoTerminalContext
    store = createTerminalContextStore()
  })

  test('concurrent sessions coexist; latest published is active', () => {
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    store.publish({ sessionId: 'b', tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })
    expect(store.current()?.cwd).toBe('/b')
  })

  test('withdrawing the inactive session does not disturb the active one', () => {
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    store.publish({ sessionId: 'b', tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })

    store.withdraw('a')

    expect(store.isReady()).toBe(true)
    expect(store.current()?.cwd).toBe('/b')
  })

  test('withdrawing the active session promotes the newest remaining session', () => {
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 10 })
    store.publish({ sessionId: 'b', tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 5 })
    // b is active (last published). Withdraw it → newest remaining (a) is promoted.
    store.withdraw('b')

    expect(store.isReady()).toBe(true)
    expect(store.current()?.cwd).toBe('/a')
  })

  test('withdrawing the last session clears the store', () => {
    store.publish({ sessionId: 'only', tracker: createMockTracker('/o'), bridge: createMockBridge(), cwd: '/o', publishedAt: 1 })
    store.withdraw('only')
    expect(store.isReady()).toBe(false)
    expect(store.current()).toBeNull()
  })

  test('setActiveSession switches the targeted terminal; unknown id is a no-op', () => {
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    store.publish({ sessionId: 'b', tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })

    store.setActiveSession('a')
    expect(store.current()?.cwd).toBe('/a')

    store.setActiveSession('does-not-exist')
    expect(store.current()?.cwd).toBe('/a')
  })

  test('re-publishing an existing session id updates in place without adding a duplicate', () => {
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a'), bridge: createMockBridge(), cwd: '/a', publishedAt: 1 })
    store.publish({ sessionId: 'b', tracker: createMockTracker('/b'), bridge: createMockBridge(), cwd: '/b', publishedAt: 2 })
    store.publish({ sessionId: 'a', tracker: createMockTracker('/a2'), bridge: createMockBridge(), cwd: '/a2', publishedAt: 3 })

    expect(store.current()?.cwd).toBe('/a2')
    // Withdrawing a leaves exactly one remaining session (b).
    store.withdraw('a')
    expect(store.current()?.cwd).toBe('/b')
    store.withdraw('b')
    expect(store.isReady()).toBe(false)
  })

  test('default (id-less) callers share one key and stay isolated from keyed sessions', () => {
    store.publish({ tracker: createMockTracker('/default'), bridge: createMockBridge(), cwd: '/default', publishedAt: 1 })
    store.publish({ sessionId: 'keyed', tracker: createMockTracker('/keyed'), bridge: createMockBridge(), cwd: '/keyed', publishedAt: 2 })

    // Withdrawing the keyed one promotes the default session back.
    store.withdraw('keyed')
    expect(store.current()?.cwd).toBe('/default')
  })
})

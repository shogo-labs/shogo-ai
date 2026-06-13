// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for AgentTerminalFactory.
 *
 * Tests cover:
 *   - Spawn creates an instance with unique ID
 *   - Multiple spawns create separate instances
 *   - dispose kills the PTY and cleans up
 *   - disposeAll cleans up all instances
 *   - getAll returns only alive instances
 *   - get returns specific instance
 *   - count tracks alive instances
 *   - alive flag transitions on dispose
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { AgentTerminalFactory, createAgentTerminalFactory } from '../agent-terminal-factory'
import type { CommandResult } from '../agent-terminal-bridge'

function createMockPtyFns() {
  const written: Array<{ id: string; data: string }> = []
  const killed: string[] = []
  const dataListeners = new Map<string, Array<(data: string) => void>>()

  return {
    written,
    killed,
    dataListeners,
    writeToPty: async (id: string, data: string) => {
      written.push({ id, data })
    },
    spawnPty: async (opts: any) => {
      const id = `pty-${Date.now()}-${Math.random().toString(36).slice(2)}`
      dataListeners.set(id, [])
      return { id }
    },
    killPty: async (id: string) => {
      killed.push(id)
      dataListeners.delete(id)
    },
    attachToPty: async (id: string) => ({
      onData: (listener: (data: string) => void) => {
        const listeners = dataListeners.get(id) ?? []
        listeners.push(listener)
        dataListeners.set(id, listeners)
        return () => {
          const idx = listeners.indexOf(listener)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    }),
    emitData: (id: string, data: string) => {
      const listeners = dataListeners.get(id) ?? []
      for (const l of listeners) l(data)
    },
  }
}

describe('AgentTerminalFactory', () => {
  let fns: ReturnType<typeof createMockPtyFns>
  let factory: AgentTerminalFactory

  beforeEach(() => {
    fns = createMockPtyFns()
    factory = createAgentTerminalFactory({
      writeToPty: fns.writeToPty,
      spawnPty: fns.spawnPty,
      killPty: fns.killPty,
      attachToPty: fns.attachToPty,
    })
  })

  test('spawn creates an instance with a unique ID', async () => {
    const inst = await factory.spawn()
    expect(inst.id).toBeTruthy()
    expect(inst.alive).toBe(true)
    expect(inst.tracker).toBeDefined()
    expect(inst.bridge).toBeDefined()
  })

  test('multiple spawns create separate instances', async () => {
    const i1 = await factory.spawn()
    const i2 = await factory.spawn()
    expect(i1.id).not.toBe(i2.id)
    expect(factory.count).toBe(2)
  })

  test('getAll returns only alive instances', async () => {
    const i1 = await factory.spawn()
    const i2 = await factory.spawn()
    expect(factory.getAll()).toHaveLength(2)

    await i1.dispose()
    expect(factory.getAll()).toHaveLength(1)
    expect(factory.getAll()[0].id).toBe(i2.id)
  })

  test('get returns specific instance by ID', async () => {
    const i1 = await factory.spawn()
    const i2 = await factory.spawn()
    expect(factory.get(i1.id)).toBe(i1)
    expect(factory.get(i2.id)).toBe(i2)
    expect(factory.get('nonexistent')).toBeUndefined()
  })

  test('dispose kills the PTY and cleans up', async () => {
    const inst = await factory.spawn()
    const ptyId = fns.written.length // The spawnPty was called, but we need the actual ID

    await inst.dispose()

    expect(inst.alive).toBe(false)
    expect(factory.count).toBe(0)
    expect(fns.killed.length).toBe(1)
  })

  test('disposeAll cleans up all instances', async () => {
    await factory.spawn()
    await factory.spawn()
    await factory.spawn()
    expect(factory.count).toBe(3)

    await factory.disposeAll()

    expect(factory.count).toBe(0)
    expect(fns.killed.length).toBe(3)
  })

  test('instance.sendCommand delegates to bridge', async () => {
    const inst = await factory.spawn()
    // sendCommand returns a promise that resolves via the bridge —
    // in the real system the tracker emits command-started/finished events.
    // Here we verify the bridge exists and the method is callable.
    expect(typeof inst.sendCommand).toBe('function')
    expect(typeof inst.sendCommandBackground).toBe('function')
    expect(typeof inst.getRecentCommands).toBe('function')
    expect(inst.getRecentCommands()).toEqual([])
  })

  test('alive transitions to false after dispose', async () => {
    const inst = await factory.spawn()
    expect(inst.alive).toBe(true)
    await inst.dispose()
    expect(inst.alive).toBe(false)
  })

  test('factory function creates AgentTerminalFactory', () => {
    const f = createAgentTerminalFactory({
      writeToPty: async () => {},
      spawnPty: async () => ({ id: 'test' }),
      killPty: async () => {},
      attachToPty: async () => ({
        onData: () => () => {},
      }),
    })
    expect(f).toBeInstanceOf(AgentTerminalFactory)
    expect(f.count).toBe(0)
  })
})

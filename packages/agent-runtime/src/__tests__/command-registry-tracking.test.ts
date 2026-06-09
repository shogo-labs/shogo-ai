// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandRegistry process-tracking surface: listRunning / snapshot /
 * restoreStale / kill / onChange. These power exec_list, the process HTTP
 * endpoints, and the live UI panel.
 */

import { describe, test, expect } from 'bun:test'
import { CommandRegistry, type RunningProcessSnapshot } from '../command-registry'
import type { CommandHandle } from '../sandbox-exec'

/** Build a controllable fake handle whose `done` we resolve manually. */
function fakeHandle(opts?: { pid?: number; sandboxed?: boolean; containerName?: string }) {
  let exited = false
  let resolveDone!: (r: { exitCode: number; stdout: string; stderr: string; killed: boolean }) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }>((res) => {
    resolveDone = res
  })
  let killSignal: string | undefined
  const handle: CommandHandle = {
    pid: opts?.pid ?? 4242,
    containerName: opts?.containerName,
    sandboxed: opts?.sandboxed ?? false,
    stdout: () => '',
    stderr: () => '',
    done,
    kill: (signal = 'SIGTERM') => { killSignal = signal },
    exited: () => exited,
    startedAt: Date.now(),
  }
  return {
    handle,
    finish: (exitCode = 0) => {
      exited = true
      resolveDone({ exitCode, stdout: '', stderr: '', killed: false })
    },
    killSignal: () => killSignal,
  }
}

describe('CommandRegistry.listRunning', () => {
  test('includes a freshly registered run and excludes it once finished', async () => {
    const reg = new CommandRegistry()
    const f = fakeHandle({ pid: 111 })
    const entry = reg.register('sleep 99', f.handle)

    let running = reg.listRunning()
    expect(running).toHaveLength(1)
    expect(running[0]!.runId).toBe(entry.runId)
    expect(running[0]!.pid).toBe(111)
    expect(running[0]!.command).toBe('sleep 99')
    expect(typeof running[0]!.elapsedMs).toBe('number')
    expect(running[0]!.stale).toBeUndefined()

    f.finish(0)
    await f.handle.done
    // Allow the `.then` bookkeeping microtask to run.
    await Promise.resolve()

    running = reg.listRunning()
    expect(running).toHaveLength(0)
  })
})

describe('CommandRegistry.snapshot + restoreStale', () => {
  test('snapshot round-trips into stale entries that listRunning reports', () => {
    const source = new CommandRegistry()
    source.register('npm run dev', fakeHandle({ pid: 900, sandboxed: true, containerName: 'shogo-exec-abc' }).handle)
    const snap = source.snapshot()
    expect(snap).toHaveLength(1)

    const restored = new CommandRegistry()
    restored.restoreStale(snap)

    const running = restored.listRunning()
    expect(running).toHaveLength(1)
    expect(running[0]!.command).toBe('npm run dev')
    expect(running[0]!.pid).toBe(900)
    expect(running[0]!.stale).toBe(true)
  })

  test('restoreStale ignores duplicate run ids', () => {
    const reg = new CommandRegistry()
    const snap: RunningProcessSnapshot[] = [
      { runId: 'cmd_dup', command: 'x', pid: 1, sandboxed: false, startedAt: Date.now() },
    ]
    reg.restoreStale(snap)
    reg.restoreStale(snap)
    expect(reg.listRunning()).toHaveLength(1)
  })
})

describe('CommandRegistry.kill', () => {
  test('kills a running entry with SIGKILL and returns true', () => {
    const reg = new CommandRegistry()
    const f = fakeHandle()
    const entry = reg.register('sleep 99', f.handle)
    expect(reg.kill(entry.runId)).toBe(true)
    expect(f.killSignal()).toBe('SIGKILL')
  })

  test('dismisses a stale entry (no signal) and removes it', () => {
    const reg = new CommandRegistry()
    reg.restoreStale([{ runId: 'cmd_stale', command: 'x', pid: 7, sandboxed: false, startedAt: Date.now() }])
    expect(reg.kill('cmd_stale')).toBe(true)
    expect(reg.listRunning()).toHaveLength(0)
  })

  test('returns false for an unknown run id', () => {
    const reg = new CommandRegistry()
    expect(reg.kill('cmd_missing')).toBe(false)
  })
})

describe('CommandRegistry.onChange', () => {
  test('fires on register and on completion, and unsubscribes cleanly', async () => {
    const reg = new CommandRegistry()
    const seen: number[] = []
    const unsub = reg.onChange((running) => seen.push(running.length))

    const f = fakeHandle()
    reg.register('sleep 99', f.handle)
    expect(seen.at(-1)).toBe(1) // register emitted with one running

    f.finish(0)
    await f.handle.done
    await Promise.resolve()
    expect(seen.at(-1)).toBe(0) // completion emitted with none running

    unsub()
    reg.register('echo hi', fakeHandle().handle)
    // No new event after unsubscribe.
    expect(seen.at(-1)).toBe(0)
  })
})

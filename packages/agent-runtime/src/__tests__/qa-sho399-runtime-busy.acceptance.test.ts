// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-399 — a runtime can stay "busy" forever and never take a release.
 *
 * Three separate ways one stray task pinned a production VM off the current
 * rootfs, and what is true after this card:
 *   1. a remote (API-owned) task mirror counts as busy → it no longer does;
 *   2. an exec background command has no time limit → it is capped, and settles
 *      `interrupted` with the reason so its owner reads why;
 *   3. a needed long-running process had no way to survive a recycle → it can be
 *      declared a service, and comes back.
 *
 * The metal side (rotation past the deadline) lives in apps/metal-agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  TaskRegistry,
  EXEC_BACKGROUND_MAX_MS,
  backgroundCapSummary,
  execBackgroundMaxMs,
  type RemoteTaskClient,
} from '../task-registry'
import { guestBusy } from '../runtime-busy'
import { declareService, deriveServiceName, readDeclaredServices, serviceTmpWarning, undeclareService } from '../services-registry'
import { findSelfMatchingPattern } from '../exec-detach'
import type { CommandHandle } from '../sandbox-exec'

const TEST_DIR = '/tmp/qa-sho399-runtime-busy'

function fakeHandle(startedAt = Date.now()) {
  let exited = false
  let resolveDone!: (r: { exitCode: number; stdout: string; stderr: string; killed: boolean }) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }>((res) => {
    resolveDone = res
  })
  const handle: CommandHandle = {
    pid: 4242,
    sandboxed: false,
    stdout: () => '',
    stderr: () => '',
    recentOutput: () => '',
    done,
    kill: () => {
      exited = true
      resolveDone({ exitCode: 137, stdout: '', stderr: '', killed: true })
    },
    exited: () => exited,
    startedAt,
    onData: () => () => {},
  }
  return { handle, finish: () => { exited = true; resolveDone({ exitCode: 0, stdout: '', stderr: '', killed: false }) } }
}

/** A remote client that always reports the task still running. */
function stuckRemote(): RemoteTaskClient {
  return {
    get: async () => ({ id: 'remote', status: 'running' }) as any,
    cancel: async () => {},
  } as unknown as RemoteTaskClient
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
})
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

describe('1. a card watch is not "work this runtime is doing"', () => {
  test('activeWorkCounts ignores a running remote task but keeps a local shell task and its child', () => {
    const reg = new TaskRegistry({})
    reg.registerRemote({ id: 'card-watch', source: 'work_item', title: 'CAR-1', client: stuckRemote(), startedAt: Date.now() - 2 * 24 * 3600_000 })
    expect(reg.listRunning().map((t) => t.id)).toContain('card-watch')
    expect(reg.activeWorkCounts()).toEqual({ tasks: 0, children: 0 })

    const local = fakeHandle()
    reg.register('sleep 600', local.handle, { title: 'sleep 600' })
    reg.markBackgrounded(reg.listAll()[0]!.id)
    expect(reg.activeWorkCounts().tasks).toBe(1)
    // The live child counts too: the process is real even though its row is new.
    expect(reg.activeWorkCounts().children).toBe(1)
    void reg.killAll()
  })

  test('all three remote sources stay out of the count (work_item, project_call, agent_reply)', () => {
    const reg = new TaskRegistry({})
    for (const source of ['work_item', 'project_call', 'agent_reply'] as const) {
      reg.registerRemote({ id: `t-${source}`, source, title: source, client: stuckRemote() })
    }
    expect(reg.activeWorkCounts()).toEqual({ tasks: 0, children: 0 })
  })

  test('getActivityStats().busy is false when the only task is a card watch', () => {
    const reg = new TaskRegistry({})
    reg.registerRemote({ id: 'card-watch', source: 'work_item', title: 'CAR-2', client: stuckRemote() })
    const counts = reg.activeWorkCounts()
    // The exact formula `getActivityStats` reports to /pool/activity.
    expect(guestBusy({ turns: 0, tasks: counts.tasks, liveStreams: 0 })).toBe(false)

    const local = fakeHandle()
    reg.register('sleep 600', local.handle)
    expect(guestBusy({ turns: 0, tasks: reg.activeWorkCounts().tasks, liveStreams: 0 })).toBe(true)
    void reg.killAll()
  })
})

describe('2. a background command is capped', () => {
  test('the cap defaults to 6 h and honours the env override', () => {
    expect(EXEC_BACKGROUND_MAX_MS).toBe(6 * 60 * 60 * 1000)
    expect(execBackgroundMaxMs({})).toBe(EXEC_BACKGROUND_MAX_MS)
    expect(execBackgroundMaxMs({ SHOGO_EXEC_BACKGROUND_MAX_MS: '1500' })).toBe(1500)
    expect(execBackgroundMaxMs({ SHOGO_EXEC_BACKGROUND_MAX_MS: 'nonsense' })).toBe(EXEC_BACKGROUND_MAX_MS)
  })

  test('a task past the cap is killed, settles interrupted with the cap summary, and queues a note', () => {
    const reg = new TaskRegistry({ backgroundMaxMs: 1_000 })
    const { handle } = fakeHandle(Date.now() - 5_000)
    const entry = reg.register('while pgrep -f render.ts; do sleep 30; done', handle, { title: 'render poll' })
    reg.markBackgrounded(entry.id)

    const stopped = reg.enforceBackgroundCap()
    expect(stopped).toEqual([entry.id])
    const after = reg.get(entry.id)!
    expect(after.status).toBe('interrupted')
    expect(after.result?.summary).toBe(backgroundCapSummary(1_000))
    expect(after.result?.summary).toContain('service: true')
    const notes = reg.peekNotifications()
    expect(notes.map((n) => n.taskId)).toEqual([entry.id])
    expect(notes[0]!.status).toBe('interrupted')
    void reg.killAll()
  })

  test('a task younger than the cap is untouched', () => {
    const reg = new TaskRegistry({ backgroundMaxMs: 60_000 })
    const { handle } = fakeHandle()
    const entry = reg.register('sleep 30', handle)
    reg.markBackgrounded(entry.id)
    expect(reg.enforceBackgroundCap()).toEqual([])
    expect(reg.get(entry.id)!.status).toBe('running')
    void reg.killAll()
  })

  test('a service past the cap keeps running', () => {
    const reg = new TaskRegistry({ backgroundMaxMs: 1_000 })
    const { handle } = fakeHandle(Date.now() - 60_000)
    const entry = reg.register('bun wa-gateway.ts', handle, { service: true, name: 'wa-gateway' })
    reg.markBackgrounded(entry.id)
    expect(reg.enforceBackgroundCap()).toEqual([])
    expect(reg.get(entry.id)!.status).toBe('running')
    expect(reg.listAll()[0]!.service).toBe(true)
    void reg.killAll()
  })
})

describe('3. declared services survive a recycle and a cold boot', () => {
  test('declare / read / undeclare round-trips through .shogo/services.json', () => {
    const svc = { name: 'wa-gateway', command: 'bun .tmp/wa-gateway.ts', cwd: TEST_DIR, sessionId: 'chat', declaredAt: 1 }
    declareService(TEST_DIR, svc)
    expect(readDeclaredServices(TEST_DIR)).toEqual([svc])
    // Re-declaring the same name replaces it rather than duplicating.
    declareService(TEST_DIR, { ...svc, command: 'bun gateway.ts', declaredAt: 2 })
    expect(readDeclaredServices(TEST_DIR)).toHaveLength(1)
    expect(readDeclaredServices(TEST_DIR)[0]!.command).toBe('bun gateway.ts')

    expect(undeclareService(TEST_DIR, 'wa-gateway')).toBe(true)
    expect(undeclareService(TEST_DIR, 'wa-gateway')).toBe(false)
    expect(readDeclaredServices(TEST_DIR)).toEqual([])
    expect(JSON.parse(readFileSync(join(TEST_DIR, '.shogo', 'services.json'), 'utf8'))).toEqual({ services: [] })
  })

  test('a missing or corrupt services.json reads as no services', () => {
    expect(readDeclaredServices(TEST_DIR)).toEqual([])
    writeFileSync(join(TEST_DIR, '.shogo', 'services.json'), '{ not json', 'utf8')
    expect(readDeclaredServices(TEST_DIR)).toEqual([])
  })

  test('a service name defaults to its command', () => {
    expect(deriveServiceName('bun .tmp/wa-gateway.ts')).toBe('bun wa-gateway.ts')
    expect(deriveServiceName('/usr/local/bin/cloudflared tunnel run')).toBe('cloudflared tunnel')
    expect(deriveServiceName('SHOGO=1 node server.js')).toBe('node server.js')
  })

  test('a .tmp/ reference warns that a recycle does not keep it', () => {
    expect(serviceTmpWarning('bun .tmp/wa-gateway.ts')).toContain('.tmp/` is not kept')
    expect(serviceTmpWarning('cloudflared tunnel --config .tmp/tunnel.yml run')).toContain('.tmp/` is not kept')
    expect(serviceTmpWarning('bun gateway.ts')).toBeUndefined()
    expect(serviceTmpWarning('bun ./scripts/tmp-check.ts')).toBeUndefined()
  })

  test('a service row is not restored from the snapshot: services.json is the source of truth', () => {
    const reg = new TaskRegistry({})
    reg.restoreStale([
      {
        runId: 't_service',
        command: 'bun wa-gateway.ts',
        pid: 1,
        sandboxed: false,
        startedAt: Date.now() - 60_000,
        source: 'shell',
        title: 'bun wa-gateway.ts',
        status: 'interrupted',
        finishedAt: Date.now() - 30_000,
        service: true,
        name: 'wa-gateway',
      },
    ])
    expect(reg.get('t_service')).toBeUndefined()
  })
})

describe('4. a task stopped for a release tells its owner after the restart', () => {
  test('stopForRelease settles interrupted with the release reason and carries the note across the restart', () => {
    const reg = new TaskRegistry({})
    const { handle } = fakeHandle()
    const entry = reg.register('rsync -a series/ /backup/series', handle, { title: 'series render' })
    reg.markBackgrounded(entry.id)

    expect(reg.stopForRelease({ reason: 'this runtime moved to the new release', note: '.tmp/ is not kept across a recycle' })).toBe(1)
    expect(reg.get(entry.id)!.status).toBe('interrupted')
    expect(reg.get(entry.id)!.result?.summary).toBe(
      'stopped: this runtime moved to the new release (.tmp/ is not kept across a recycle)',
    )

    const snapshot = reg.snapshot()
    const row = snapshot.find((s) => s.runId === entry.id)!
    expect(row.notifyOnRestore).toBe(true)

    // The next VM: a fresh registry restores from that snapshot.
    const next = new TaskRegistry({})
    next.restoreStale(snapshot)
    const restored = next.get(entry.id)!
    expect(restored.status).toBe('interrupted')
    expect(restored.result?.summary).toContain('moved to the new release')
    // The note is queued, not restored silently.
    expect(next.peekNotifications().map((n) => n.taskId)).toEqual([entry.id])
  })

  test('a service is stopped for the release but not announced (it comes back)', () => {
    const reg = new TaskRegistry({})
    const { handle } = fakeHandle()
    const entry = reg.register('bun wa-gateway.ts', handle, { service: true, name: 'wa-gateway' })
    reg.markBackgrounded(entry.id)
    reg.stopForRelease({ reason: 'this runtime moved to the new release' })
    expect(reg.get(entry.id)!.status).toBe('interrupted')
    expect(reg.snapshot().find((s) => s.runId === entry.id)!.notifyOnRestore).toBeUndefined()
    expect(reg.peekNotifications()).toEqual([])
  })

  test('an ordinary restart of the same row is still silent (only a release hands the note over)', () => {
    const reg = new TaskRegistry({})
    const { handle } = fakeHandle()
    const entry = reg.register('sleep 100', handle)
    reg.markBackgrounded(entry.id)
    void reg.killAll()
    const next = new TaskRegistry({})
    next.restoreStale(reg.snapshot())
    expect(next.get(entry.id)!.status).toBe('interrupted')
    expect(next.peekNotifications()).toEqual([])
  })
})

describe('5. exec steers a pgrep -f that matches its own command line', () => {
  test('a self-matching pattern is reported', () => {
    const cmd = 'while pgrep -f "render.ts"; do sleep 30; done'
    expect(findSelfMatchingPattern(cmd)).toEqual({ program: 'pgrep', pattern: 'render.ts' })
    expect(findSelfMatchingPattern('pkill -f cloudflared')).toEqual({ program: 'pkill', pattern: 'cloudflared' })
  })

  test('the bracket trick, an exact match and an escaped pattern are clean', () => {
    expect(findSelfMatchingPattern('while pgrep -f "[r]ender.ts"; do sleep 30; done')).toBeUndefined()
    expect(findSelfMatchingPattern('pgrep -x node')).toBeUndefined()
    // Anything quoted in the command is in its own argv, so a plain pattern
    // always self-matches; an escaped one does not (the text keeps the `\`).
    expect(findSelfMatchingPattern('pgrep -f "render\\.ts"')).toBeUndefined()
  })
})

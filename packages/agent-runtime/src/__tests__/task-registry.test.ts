// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TaskRegistry: one model for shell commands, subagents and API-tracked
 * tasks. Covers notification rules (only backgrounded, unseen, not being
 * waited on), wait outcomes, remote clients, dormant cards, Stop muting and
 * the consumption hand-off to the API.
 */

import { describe, test, expect } from 'bun:test'
import {
  TaskRegistry,
  COMPLETED_RETENTION_MS,
  formatTaskNotification,
  type RemoteTaskClient,
  type RemoteTaskState,
} from '../task-registry'
import type { CommandHandle } from '../sandbox-exec'

function fakeHandle() {
  let exited = false
  let output = ''
  const listeners = new Set<(chunk: string, stream: 'stdout' | 'stderr') => void>()
  let resolveDone!: (r: { exitCode: number; stdout: string; stderr: string; killed: boolean }) => void
  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean }>((res) => {
    resolveDone = res
  })
  const handle: CommandHandle = {
    pid: 4242,
    sandboxed: false,
    stdout: () => output,
    stderr: () => '',
    recentOutput: () => output,
    done,
    kill: () => {
      exited = true
      resolveDone({ exitCode: 137, stdout: output, stderr: '', killed: true })
    },
    exited: () => exited,
    startedAt: Date.now(),
    onData: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    handle,
    write(chunk: string) {
      output += chunk
      for (const l of listeners) l(chunk, 'stdout')
    },
    finish(exitCode = 0) {
      exited = true
      resolveDone({ exitCode, stdout: output, stderr: '', killed: false })
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * A handle whose tree kill is verified separately from the signal (SHO-144):
 * `kill()` is fire-and-forget, `killTree()` says what is still running.
 */
function handleWithTree(survivors: Array<{ pid: number; name: string }> = []) {
  const f = fakeHandle()
  const kills: Array<{ graceMs?: number }> = []
  return {
    ...f,
    handle: {
      ...f.handle,
      killTree: async (opts?: { graceMs?: number }) => {
        kills.push(opts ?? {})
        f.finish(137)
        return { survivors }
      },
    } as CommandHandle,
    kills,
  }
}

/** A scripted remote client: `state` is what the next get returns. */
function fakeClient(initial: RemoteTaskState['status'] = 'running') {
  const calls = { get: [] as Array<{ id: string; waitMs?: number; until?: string }>, cancel: [] as string[], consume: [] as string[][] }
  let state: RemoteTaskState = { id: '', status: initial, output: '' }
  const client: RemoteTaskClient = {
    async get(id, opts) {
      calls.get.push({ id, ...opts })
      return { ...state, id }
    },
    async cancel(id) { calls.cancel.push(id) },
    async consume(ids) { calls.consume.push(ids) },
  }
  return { client, calls, set(next: Partial<RemoteTaskState>) { state = { ...state, ...next } } }
}

describe('notifications', () => {
  test('a backgrounded shell task queues one note when it finishes', async () => {
    const reg = new TaskRegistry()
    const f = fakeHandle()
    const entry = reg.register('bun test', f.handle)
    reg.markBackgrounded(entry.id)
    const seen: string[] = []
    reg.onNotification((n) => seen.push(n.taskId))

    f.write('3 pass\n1 fail\n')
    f.finish(1)
    await f.handle.done
    await tick()

    expect(seen).toEqual([entry.id])
    const notes = reg.consumeCompletionNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`[Task update] bun test (${entry.id}) failed (exit code 1).`)
    expect(notes[0]).toContain('1 fail')
    expect(reg.consumeCompletionNotes()).toEqual([])
  })

  test('a command that finished inside its own exec call never notifies', async () => {
    const reg = new TaskRegistry()
    const f = fakeHandle()
    reg.register('true', f.handle)
    f.finish(0)
    await f.handle.done
    await tick()
    expect(reg.hasPendingNotifications()).toBe(false)
  })

  test('a task finishing while wait observes it is returned by the wait, not as a note', async () => {
    const reg = new TaskRegistry()
    const f = fakeHandle()
    const entry = reg.register('build', f.handle)
    reg.markBackgrounded(entry.id)
    const waiting = reg.wait([entry.id], { timeoutMs: 5_000 })
    f.finish(0)
    const outcome = await waiting
    expect(outcome.kind).toBe('finished')
    expect(outcome.task?.id).toBe(entry.id)
    await tick()
    expect(reg.hasPendingNotifications()).toBe(false)
    expect(reg.get(entry.id)?.consumed).toBe(true)
  })

  test('muteRunning stops running tasks from notifying (Stop)', async () => {
    const reg = new TaskRegistry()
    const f = fakeHandle()
    const entry = reg.register('dev server', f.handle)
    reg.markBackgrounded(entry.id)
    reg.muteRunning()
    f.finish(0)
    await f.handle.done
    await tick()
    expect(reg.hasPendingNotifications()).toBe(false)
  })

  test('formatTaskNotification has one stable shape', () => {
    expect(formatTaskNotification({
      taskId: 't_1', source: 'subagent', title: 'explore: find auth', status: 'completed',
      outputFile: '.shogo/tasks/s/t_1.log', tail: 'done',
    })).toBe('[Task update] explore: find auth (t_1) completed.\nOutput: .shogo/tasks/s/t_1.log\nLast output:\ndone')
    expect(formatTaskNotification({ taskId: 't_2', source: 'shell', title: 'x', status: 'cancelled', tail: '' }))
      .toBe('[Task update] x (t_2) was cancelled.')
  })
})

describe('cancel', () => {
  test('cancel waits for the tree and reports an empty one', async () => {
    const reg = new TaskRegistry()
    const f = handleWithTree([])
    const entry = reg.register('merge', f.handle)

    const result = await reg.cancel(entry.id)

    expect(result).toEqual({ found: true, survivors: [] })
    expect(f.kills).toHaveLength(1)
    expect(reg.get(entry.id)?.status).toBe('cancelled')
  })

  test('cancel names what outlived it instead of pretending the tree is gone', async () => {
    const reg = new TaskRegistry()
    const f = handleWithTree([{ pid: 991, name: 'sleep' }])
    const entry = reg.register('merge', f.handle)

    const result = await reg.cancel(entry.id)

    expect(result.survivors).toEqual([{ pid: 991, name: 'sleep' }])
  })

  test('cancel of an unknown id is not found, and a finished task is not re-killed', async () => {
    const reg = new TaskRegistry()
    const f = handleWithTree([])
    const entry = reg.register('true', f.handle)
    f.finish(0)
    await f.handle.done
    await tick()

    expect(await reg.cancel('t_missing')).toEqual({ found: false, survivors: [] })
    expect(await reg.cancel(entry.id)).toEqual({ found: true, survivors: [] })
    expect(f.kills).toHaveLength(0)
  })

  test('killAll waits on every tree, and still settles interrupted first', async () => {
    const reg = new TaskRegistry()
    const first = handleWithTree([])
    const second = handleWithTree([])
    const a = reg.register('merge one', first.handle)
    const b = reg.register('merge two', second.handle)

    await reg.killAll()

    expect(first.kills).toHaveLength(1)
    expect(second.kills).toHaveLength(1)
    expect(reg.get(a.id)?.status).toBe('interrupted')
    expect(reg.get(b.id)?.status).toBe('interrupted')
  })
})

describe('wait', () => {
  test('returns at once for a task that already finished', async () => {
    const reg = new TaskRegistry()
    const task = reg.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })
    task.finish('completed', { summary: 'ok' })
    const outcome = await reg.wait([task.entry.id], { timeoutMs: 10_000 })
    expect(outcome.kind).toBe('finished')
  })

  test('until matches streamed output while the task keeps running', async () => {
    const reg = new TaskRegistry()
    const f = fakeHandle()
    const entry = reg.register('bun dev', f.handle)
    const waiting = reg.wait([entry.id], { timeoutMs: 5_000, until: /ready on port \d+/ })
    setTimeout(() => f.write('compiling...\nready on port 3000\n'), 20)
    const outcome = await waiting
    expect(outcome.kind).toBe('matched')
    expect(reg.get(entry.id)?.status).toBe('running')
    f.finish(0)
  })

  test('times out and leaves the task running', async () => {
    const reg = new TaskRegistry()
    const task = reg.registerTask({ source: 'subagent', title: 'slow' })
    const outcome = await reg.wait([task.entry.id], { timeoutMs: 30 })
    expect(outcome.kind).toBe('timeout')
    expect(task.entry.status).toBe('running')
  })

  test('an abort signal ends the wait', async () => {
    const reg = new TaskRegistry()
    const task = reg.registerTask({ source: 'subagent', title: 'slow' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const outcome = await reg.wait([task.entry.id], { timeoutMs: 10_000, signal: ac.signal })
    expect(outcome.kind).toBe('timeout')
  })

  test('aliases resolve: a subagent instance id waits on its task', async () => {
    const reg = new TaskRegistry()
    const task = reg.registerTask({ source: 'subagent', title: 'explore' })
    reg.addAlias('inst_42', task.entry.id)
    setTimeout(() => task.finish('completed', { summary: 'ok' }), 10)
    const outcome = await reg.wait(['inst_42'], { timeoutMs: 5_000 })
    expect(outcome.kind).toBe('finished')
    expect(outcome.task?.id).toBe(task.entry.id)
  })
})

describe('remote tasks', () => {
  test('wait long-polls the client and settles from its state', async () => {
    const reg = new TaskRegistry()
    const remote = fakeClient()
    const entry = reg.registerRemote({ id: 't_remote01', source: 'project_call', title: 'analyst', client: remote.client })
    setTimeout(() => remote.set({ status: 'completed', output: 'the report', result: { summary: 'replied' } }), 5)
    const outcome = await reg.wait([entry.id], { timeoutMs: 5_000 })
    expect(outcome.kind).toBe('finished')
    expect(reg.readOutput(entry)).toContain('the report')
    expect(remote.calls.get.length).toBeGreaterThan(0)
  })

  test('the API client hears about consumption of API-tracked tasks', async () => {
    const api = fakeClient('completed')
    const reg = new TaskRegistry({ remote: api.client })
    const entry = reg.registerRemote({ id: 't_api00001', source: 'agent_reply', title: '@Ops reply' })
    expect(entry.apiTracked).toBe(true)
    await reg.refreshRemote()
    expect(entry.status).toBe('completed')
    expect(reg.consumeCompletionNotes()).toHaveLength(1)
    expect(api.calls.consume).toEqual([[entry.id]])
  })

  test('local tasks reported for a wake are consumed through the API', async () => {
    const api = fakeClient()
    const reg = new TaskRegistry({ remote: api.client })
    const task = reg.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })
    task.finish('completed', { summary: 'ok' })
    reg.markReported([task.entry.id])
    reg.consumeCompletionNotes()
    expect(api.calls.consume).toEqual([[task.entry.id]])
  })

  test('cancel goes to the client', () => {
    const reg = new TaskRegistry()
    const remote = fakeClient()
    const entry = reg.registerRemote({ id: 't_cancel01', source: 'project_call', title: 'x', client: remote.client })
    reg.kill(entry.id)
    expect(remote.calls.cancel).toEqual([entry.id])
    expect(reg.get(entry.id)?.status).toBe('cancelled')
  })

  test('a dormant card stays hidden until waited on, then passes until to the client', async () => {
    const reg = new TaskRegistry()
    const remote = fakeClient()
    const entry = reg.registerRemote({
      id: 't_card0001', source: 'work_item', title: 'SUP-1 Fix login', ref: 'item_1',
      client: remote.client, dormant: true, notify: false,
    })
    expect(reg.listRunning()).toEqual([])
    expect(reg.pendingNotifyCount()).toBe(0)

    setTimeout(() => remote.set({ status: 'completed', output: 'moved to Done (done)', matched: true }), 5)
    const outcome = await reg.wait(['item_1'], { timeoutMs: 5_000, until: /Done/ })
    expect(outcome.kind).toBe('finished')
    expect(entry.dormant).toBeUndefined()
    expect(remote.calls.get[0]?.until).toBe('Done')
  })
})

describe('listing and persistence', () => {
  test('non-shell tasks show in the dock at once; shell commands after the delay', () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    reg.register('sleep 99', fakeHandle().handle)
    reg.registerTask({ source: 'subagent', title: 'explore' })
    expect(reg.listVisible().map((p) => p.source)).toEqual(['subagent'])
  })

  test('snapshot keeps API-tracked tasks live and local ones stale across restart', () => {
    const reg = new TaskRegistry()
    reg.registerTask({ source: 'subagent', title: 'explore' })
    reg.registerRemote({ id: 't_api00002', source: 'project_call', title: 'analyst', apiTracked: true })
    const snap = reg.snapshot()

    const restored = new TaskRegistry()
    restored.restoreStale(snap)
    // API-tracked work outlives the runtime: the API still owns it and the next
    // poll reports the truth, so it comes back live.
    const byId = new Map(restored.listRunning().map((p) => [p.id, p]))
    expect(byId.get('t_api00002')?.stale).toBeUndefined()
    expect(byId.get('t_api00002')?.remote).toBe(true)
    // A local task belonged to the dead gateway: never live again, and its
    // verdict is `interrupted` (SHO-141), not a running row awaiting Dismiss.
    expect(restored.listRunning().map((p) => p.id)).not.toContain(
      restored.listDock().find((p) => p.source === 'subagent')?.id,
    )
    const local = restored.listDock().find((p) => p.source === 'subagent')
    expect(local?.stale).toBe(true)
    expect(local?.status).toBe('interrupted')
  })
})

describe('the dock list', () => {
  /** A task that started in the background and has already settled. */
  async function finishedTask(reg: TaskRegistry, command: string, exitCode = 0) {
    const f = fakeHandle()
    const entry = reg.register(command, f.handle)
    reg.markBackgrounded(entry.id)
    f.finish(exitCode)
    await tick()
    return entry
  }

  test('a finished task keeps its row, running ones first', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    const done = await finishedTask(reg, 'bun test')
    const running = reg.registerTask({ source: 'subagent', title: 'explore' })

    const dock = reg.listDock()
    expect(dock.map((p) => p.id)).toEqual([running.entry.id, done.id])
    expect(dock[1]?.status).toBe('completed')
    expect(dock[1]?.finishedAt).toBeGreaterThan(0)
    // The agent's own list stays running-only.
    expect(reg.listVisible().map((p) => p.id)).toEqual([running.entry.id])
  })

  test('finished rows are newest first', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    const first = await finishedTask(reg, 'bun test')
    await new Promise((r) => setTimeout(r, 5))
    const second = await finishedTask(reg, 'bun build')
    expect(reg.listDock().map((p) => p.id)).toEqual([second.id, first.id])
  })

  test('a quiet shell command that came and went never appears', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 30_000 })
    const f = fakeHandle()
    reg.register('ls', f.handle)
    f.finish(0)
    await tick()
    expect(reg.listDock()).toHaveLength(0)
  })

  test('a background task announces itself the moment it is marked backgrounded', () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 30_000 })
    const keys: string[] = []
    reg.onChange(() => keys.push(reg.listDock().map((p) => p.id).join(',')))
    const entry = reg.register('sleep 900', fakeHandle().handle)
    // Still below the visibility delay: registering alone tells the dock nothing.
    expect(keys).toEqual([''])
    reg.markBackgrounded(entry.id)
    expect(keys).toEqual(['', entry.id])
    expect(reg.listDock().map((p) => p.id)).toEqual([entry.id])
  })

  test('a dormant card stays hidden and entries drop past the retention window', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    reg.registerTask({ source: 'work_item', title: 'SUP-1', dormant: true })
    const done = await finishedTask(reg, 'bun test')
    expect(reg.listDock().map((p) => p.id)).toEqual([done.id])

    reg.get(done.id)!.finishedAt = Date.now() - COMPLETED_RETENTION_MS - 1
    expect(reg.listDock()).toHaveLength(0)
  })

  test('a failed task reports its outcome, not just its disappearance', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    const entry = await finishedTask(reg, 'bun test', 1)
    expect(reg.listDock()[0]?.status).toBe('failed')
    expect(reg.listDock()[0]?.id).toBe(entry.id)
  })

  test('snapshot round-trip keeps a finished row finished (and drops it once stale)', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 60_000 })
    const done = await finishedTask(reg, 'bun test', 2)
    const running = reg.registerTask({ source: 'subagent', title: 'explore' })

    const snap = reg.snapshot()
    expect(snap.find((s) => s.runId === done.id)?.status).toBe('failed')

    const restored = new TaskRegistry()
    restored.restoreStale(snap)
    const byId = new Map(restored.listDock().map((p) => [p.id, p]))
    // The dead task is a terminal row; the one that was running is stale.
    expect(byId.get(done.id)?.status).toBe('failed')
    expect(byId.get(done.id)?.stale).toBeUndefined()
    expect(byId.get(running.entry.id)?.stale).toBe(true)
  })

  test('a running task the dock has not shown yet is still persisted', async () => {
    const reg = new TaskRegistry({ uiVisibleAfterMs: 30_000 })
    const hidden = reg.register('npm run dev', fakeHandle().handle)
    const done = await finishedTask(reg, 'bun test', 2)
    // Invisible to the dock (below the delay), but it must survive a restart.
    expect(reg.listDock().map((p) => p.id)).toEqual([done.id])

    const snap = reg.snapshot()
    expect(snap.map((s) => s.runId).sort()).toEqual([hidden.id, done.id].sort())
    expect(snap.find((s) => s.runId === hidden.id)?.status).toBe('running')

    const restored = new TaskRegistry()
    restored.restoreStale(snap)
    // It survives the restart (the row and its command are back) but not as a
    // live task: the process it described died with the runtime.
    const back = restored.get(hidden.id)
    expect(back?.command).toBe('npm run dev')
    expect(back?.stale).toBe(true)
    expect(back?.status).toBe('interrupted')
    expect(restored.listDock().map((p) => p.id)).toContain(hidden.id)
  })

  test('a finished row past its retention is not restored', () => {
    const reg = new TaskRegistry()
    reg.restoreStale([{
      runId: 't_old00001',
      command: 'bun test',
      pid: undefined,
      sandboxed: false,
      startedAt: Date.now() - 3_600_000,
      status: 'completed',
      finishedAt: Date.now() - COMPLETED_RETENTION_MS - 1,
    }])
    expect(reg.listDock()).toHaveLength(0)
  })

  test('without a snapshot the task logs still describe what ran', () => {
    const reg = new TaskRegistry()
    const now = Date.now()
    reg.restoreFromOutputRows([
      {
        taskId: 't_log00001',
        source: 'shell',
        title: 'bun test',
        startedAt: now - 200_000,
        path: '/tmp/.shogo/tasks/s/t_log00001.log',
        status: 'completed',
        finishedAt: now - 100_000,
        modifiedAt: now - 100_000,
      },
      {
        taskId: 't_log00002',
        source: 'shell',
        title: 'bun dev',
        startedAt: now - 60_000,
        path: '/tmp/.shogo/tasks/s/t_log00002.log',
        modifiedAt: now - 60_000,
      },
    ])
    const byId = new Map(reg.listDock().map((p) => [p.id, p]))
    expect(byId.get('t_log00001')?.status).toBe('completed')
    expect(byId.get('t_log00001')?.outputFile).toBe('/tmp/.shogo/tasks/s/t_log00001.log')
    // SHO-141: no footer means the runtime died under it, so the row is
    // `interrupted` — never a live `running` row.
    expect(byId.get('t_log00002')?.status).toBe('interrupted')
    expect(byId.get('t_log00002')?.stale).toBe(true)
  })
})

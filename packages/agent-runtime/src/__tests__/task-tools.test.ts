// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The generic task tools (`wait`, `task_list`, `task_cancel`) driven through
 * createTools, plus exec's background hand-off and the hidden legacy tools.
 *
 * Commands avoid stdout (see gateway-tools.exec.test.ts): under bun:test the
 * child stdout pipe is closed, so side effects go through files.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createTools, HIDDEN_LEGACY_TOOLS, type ToolContext } from '../gateway-tools'
import { TaskRegistry } from '../task-registry'
import { sandboxExecAsync } from '../sandbox-exec'
import { taskOutputDir, listTaskOutputRows } from '../task-output'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-task-tools'

function makeCtx(registry: TaskRegistry, frames: any[] = []): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    commandRegistry: registry,
    uiWriter: { write: (f: any) => frames.push(f) } as any,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = createTools(ctx).find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return (await tool.execute('call-1', params)).details as any
}

let registry: TaskRegistry

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
  registry = new TaskRegistry({ outputDir: taskOutputDir(TEST_DIR, 'chat-1'), workspaceDir: TEST_DIR })
})

afterEach(() => {
  void registry.killAll()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

afterAll(() => clearTrustForTests())

describe('exec background hand-off', () => {
  test('background: true returns the uniform running shape at once', async () => {
    const ctx = makeCtx(registry)
    const res = await run(ctx, 'exec', { command: 'sleep 5', background: true })
    expect(res.status).toBe('running')
    expect(res.task_id).toMatch(/^t_/)
    expect(res.output_file).toBe(`.shogo/tasks/chat-1/${res.task_id}.log`)
    expect(res.hint).toContain('wait({ task_ids: [task_id] })')
    expect(existsSync(join(TEST_DIR, res.output_file))).toBe(true)
    registry.kill(res.task_id)
  })

  test('a command past its soft timeout becomes a task', async () => {
    const ctx = makeCtx(registry)
    const res = await run(ctx, 'exec', { command: 'sleep 3', timeout: 50 })
    expect(res.status).toBe('running')
    expect(res.hint).toContain('keeps running in the background')
    registry.kill(res.task_id)
  })

  test('Stop hands a foreground command back as a task instead of blocking until its timeout', async () => {
    const ctx = { ...makeCtx(registry), projectId: '' }
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const startedAt = Date.now()
    const res = (await createTools(ctx).find((t) => t.name === 'exec')!
      .execute('call-1', { command: 'sleep 30', timeout: 600_000 }, ac.signal)).details as any
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(res.status).toBe('running')
    expect(registry.get(res.task_id)?.status).toBe('running')
    registry.kill(res.task_id)
  })
})

describe('exec_wait', () => {
  test('Stop ends the wait', async () => {
    const ctx = { ...makeCtx(registry), projectId: '' }
    const started = await run(ctx, 'exec', { command: 'sleep 30', background: true })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const startedAt = Date.now()
    const res = (await createTools(ctx).find((t) => t.name === 'exec_wait')!
      .execute('call-1', { run_id: started.task_id, pattern: 'never printed', timeout_ms: 600_000 }, ac.signal)).details as any
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(res.status).toBe('running')
    registry.kill(started.task_id)
  })
})

describe('wait', () => {
  test('returns the finished task with the same shape for any source', async () => {
    const frames: any[] = []
    const ctx = makeCtx(registry, frames)
    const started = await run(ctx, 'exec', { command: `sleep 0.2 && touch ${TEST_DIR}/done.flag`, background: true })

    const res = await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 10_000 })
    expect(res.task_id).toBe(started.task_id)
    expect(res.source).toBe('shell')
    expect(res.status).toBe('completed')
    expect(res.exit_code).toBe(0)
    expect(res.still_running).toEqual([])
    expect(existsSync(`${TEST_DIR}/done.flag`)).toBe(true)

    const waitFrames = frames.filter((f) => f.type === 'data-task-wait')
    expect(waitFrames.map((f) => f.data.active)).toEqual([true, false])
    expect(waitFrames[0].data.taskIds).toEqual([started.task_id])
  })

  test('a waited-on task does not also come back as a [Task update]', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 0.1', background: true })
    await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 10_000 })
    await new Promise((r) => setTimeout(r, 20))
    expect(registry.consumeCompletionNotes()).toEqual([])
  })

  test('times out with the tasks still running and a hint', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore: auth', backgrounded: true })
    const res = await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 30 })
    expect(res.status).toBe('timeout')
    expect(res.tasks[0]).toMatchObject({ task_id: task.entry.id, source: 'subagent', status: 'running' })
    expect(res.hint).toContain('[Task update]')
  })

  test('until returns as soon as the output matches', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'server', backgrounded: true })
    setTimeout(() => task.append('booting\nlistening on :8080\n'), 30)
    const res = await run(ctx, 'wait', { task_ids: [task.entry.id], until: 'listening on :\\d+', timeout_ms: 10_000 })
    expect(res.status).toBe('running')
    expect(res.matched).toBe('listening on :\\d+')
    expect(res.output).toContain('listening on :8080')
  })

  test('accepts a subagent instance id through its alias', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore' })
    registry.addAlias('inst_7', task.entry.id)
    task.finish('completed', { summary: 'found it' })
    const res = await run(ctx, 'wait', { task_ids: ['inst_7'], timeout_ms: 1_000 })
    expect(res.task_id).toBe(task.entry.id)
    expect(res.status).toBe('completed')
  })

  test('rejects unknown ids and bad regexes; sleeps with no ids when nothing runs', async () => {
    const ctx = makeCtx(registry)
    expect((await run(ctx, 'wait', { task_ids: ['t_nope'] })).error).toContain('Unknown task id')
    expect((await run(ctx, 'wait', { timeout_ms: 10 })).status).toBe('slept')
    const task = registry.registerTask({ source: 'subagent', title: 'x' })
    expect((await run(ctx, 'wait', { task_ids: [task.entry.id], until: '(' })).error).toContain('Invalid until regex')
  })

  test('with no task_ids, a task that already failed comes back instead of a sleep', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'echo nope > missing-dir/out.log', background: true })
    await new Promise((r) => setTimeout(r, 200))
    const res = await run(ctx, 'wait', { timeout_ms: 5_000 })
    expect(res.task_id).toBe(started.task_id)
    expect(res.status).toBe('failed')
    expect(registry.consumeCompletionNotes()).toEqual([])
  })

  test('with no task_ids, until watches every running task', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', {
      command: 'echo compiling; sleep 0.2; echo "ready on port 4321"; sleep 5',
      background: true,
    })
    const res = await run(ctx, 'wait', { until: 'ready on port \\d+', timeout_ms: 10_000 })
    expect(res.task_id).toBe(started.task_id)
    expect(res.matched).toBe('ready on port \\d+')
    expect(res.output).toContain('ready on port 4321')
  })
})

describe('wait: a result the runtime already dropped', () => {
  test('a missing task names task_list and the log, never the old retention wording', async () => {
    const ctx = makeCtx(registry)
    const res = await run(ctx, 'wait', { task_ids: ['t_nope1234'] })
    expect(res.code).toBe('task_result_gone')
    expect(String(res.error)).toContain('task_list')
    expect(String(res.error)).toContain('.shogo/tasks/chat-1/t_nope1234.log')
    expect(String(res.error)).not.toContain('kept ~10 min')
  })

  test('a result evicted from memory comes back from its output file', async () => {
    const dir = taskOutputDir(TEST_DIR, 'chat-rec')
    const reg = new TaskRegistry({
      outputDir: dir,
      workspaceDir: TEST_DIR,
      retentionMs: 20,
      resolveOutputRow: (id) => listTaskOutputRows(dir).find((r) => r.taskId === id) ?? null,
    })
    const ctx = makeCtx(reg)
    const started = await run(ctx, 'exec', { command: 'sleep 0.1; echo "18 pass"', background: true })
    await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 10_000 })
    await new Promise((r) => setTimeout(r, 80))
    expect(reg.get(started.task_id)).toBeUndefined()

    const res = await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 0 })
    expect(res.status).toBe('completed')
    expect(res.recovered).toBe(true)
    expect(res.output_file).toBe(started.output_file)
    expect(String(res.output)).toContain('18 pass')
  })
})

describe('wait: repeated timeouts stop instead of sleeping again', () => {
  test('the third wait on the same ids returns at once and says to stop', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })

    const first = await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })
    const second = await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })
    const startedAt = Date.now()
    const third = await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 5_000 })
    const elapsed = Date.now() - startedAt

    expect(first.status).toBe('timeout')
    expect(second.status).toBe('timeout')
    expect(second.code).toBeUndefined()
    expect(third.code).toBe('stop_waiting')
    expect(third.repeated).toBe(2)
    expect(String(third.hint)).toContain('[Task update]')
    expect(elapsed).toBeLessThan(50)
    task.finish('completed', { summary: 'ok' })
  })

  test('a task that settles before the third wait is returned, not stopped', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })

    expect((await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })).status).toBe('timeout')
    expect((await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 20 })).status).toBe('timeout')
    task.finish('completed', { summary: 'the report' })
    const startedAt = Date.now()

    const third = await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 5_000 })

    expect(Date.now() - startedAt).toBeLessThan(50)
    expect(third.status).toBe('completed')
    expect(third.code).toBeUndefined()
    expect(third.task_id).toBe(task.entry.id)
    // The agent has now read it, so the counter and the lease both clear.
    expect(registry.get(task.entry.id)?.consumed).toBe(true)
  })

  test('a finished result clears the counter', async () => {
    const ctx = makeCtx(registry)
    const task = registry.registerTask({ source: 'subagent', title: 'explore', backgrounded: true })
    await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 10 })
    task.finish('completed', { summary: 'ok' })
    expect((await run(ctx, 'wait', { task_ids: [task.entry.id], timeout_ms: 10 })).status).toBe('completed')

    const next = registry.registerTask({ source: 'subagent', title: 'again', backgrounded: true })
    const res = await run(ctx, 'wait', { task_ids: [next.entry.id], timeout_ms: 10 })
    expect(res.status).toBe('timeout')
    expect(res.code).toBeUndefined()
    next.finish('completed', { summary: 'ok' })
  })
})

describe('exec: a sleep poll while a task runs', () => {
  test('the first poll still runs, and carries the steering', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 5', background: true })

    const res = await run(ctx, 'exec', { command: 'sleep 0.05 && echo checking' })

    expect(res.steering.code).toBe('wait_instead_of_poll')
    expect(res.steering.running_tasks).toEqual([started.task_id])
    expect(res.steering.hint).toContain(`wait({ task_ids: ["${started.task_id}"] })`)
    expect(res.stdout ?? res.output).toContain('checking')
    registry.kill(started.task_id)
  })

  test('a second poll is refused and names the wait call', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 5', background: true })
    await run(ctx, 'exec', { command: 'sleep 0.05' })

    const res = await run(ctx, 'exec', { command: 'sleep 0.05 && echo nope again' })

    expect(res.ok).toBe(false)
    expect(res.code).toBe('use_wait_instead')
    expect(res.running_tasks).toEqual([started.task_id])
    expect(res.hint).toContain(`wait({ task_ids: ["${started.task_id}"] })`)
    registry.kill(started.task_id)
  })

  test('a poll that reads the task output names that task, and how to wait for a port', async () => {
    const ctx = makeCtx(registry)
    const quiet = await run(ctx, 'exec', { command: 'sleep 5', background: true })
    const served = await run(ctx, 'exec', { command: 'sleep 6', background: true })

    const res = await run(ctx, 'exec', { command: `sleep 0.05 && tail -3 ${served.output_file}` })

    expect(res.steering.code).toBe('wait_instead_of_poll')
    expect(res.steering.running_tasks).toEqual([served.task_id])
    expect(res.steering.hint).toContain(`wait({ task_ids: ["${served.task_id}"] })`)
    expect(res.steering.hint).toContain('until')
    registry.kill(quiet.task_id)
    registry.kill(served.task_id)
  })

  test('a sleep waiting on a server, CI or a rebuild is left alone', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 5', background: true })

    for (const command of [
      'sleep 0.05 && curl -s localhost:3000',
      'sleep 0.05 && tail .shogo/logs/build.log',
      'sleep 0.05 && gh pr checks 1633',
    ]) {
      const res = await run(ctx, 'exec', { command })
      expect(res.steering).toBeUndefined()
      expect(res.code).toBeUndefined()
    }
    registry.kill(started.task_id)
  })

  test('with nothing running a sleep still runs untouched', async () => {
    const ctx = makeCtx(registry)
    const res = await run(ctx, 'exec', { command: 'sleep 0.05 && echo paced' })
    expect(res.steering).toBeUndefined()
    expect(res.code).toBeUndefined()
    expect(res.stdout ?? res.output).toContain('paced')
  })
})

describe('task_list and task_cancel', () => {
  test('lists every source and cancels one', async () => {
    const ctx = makeCtx(registry)
    const shell = await run(ctx, 'exec', { command: 'sleep 5', background: true })
    const agent = registry.registerTask({ source: 'subagent', title: 'explore' })

    const listed = await run(ctx, 'task_list', {})
    const byId = new Map(listed.tasks.map((t: any) => [t.task_id, t]))
    expect((byId.get(shell.task_id) as any).source).toBe('shell')
    expect((byId.get(agent.entry.id) as any).status).toBe('running')

    const cancelled = await run(ctx, 'task_cancel', { task_id: agent.entry.id })
    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled' })
    expect(registry.consumeCompletionNotes()).toEqual([])

    await run(ctx, 'task_cancel', { task_id: shell.task_id })
    const finished = await run(ctx, 'wait', { task_ids: [shell.task_id], timeout_ms: 5_000 })
    expect(['cancelled', 'failed']).toContain(finished.status)
    expect((await run(ctx, 'task_cancel', { task_id: 't_missing' })).error).toContain('Unknown task id')
  })
})

describe('task_cancel on a shell task', () => {
  test('stops the processes the shell started, not just the shell', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 30 & echo "child $!"; wait', background: true })
    const seen = await run(ctx, 'wait', { task_ids: [started.task_id], until: 'child \\d+', timeout_ms: 5_000 })
    const childPid = Number(seen.output.match(/child (\d+)/)![1])
    expect(() => process.kill(childPid, 0)).not.toThrow()

    await run(ctx, 'task_cancel', { task_id: started.task_id })
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  test('reports an empty survivors list for a tree it actually emptied', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 30', background: true })

    const cancelled = await run(ctx, 'task_cancel', { task_id: started.task_id })

    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled', survivors: [] })
    expect(registry.get(started.task_id)?.status).toBe('cancelled')
  })

  test('a tree it could not empty is named, never reported as cancelled', async () => {
    const ctx = makeCtx(registry)
    const entry = registry.register('merge waiter', {
      pid: 999_999,
      sandboxed: false,
      stdout: () => '',
      stderr: () => '',
      recentOutput: () => '',
      done: new Promise(() => {}),
      kill: () => {},
      exited: () => false,
      startedAt: Date.now(),
      killTree: async () => ({ survivors: [{ pid: 991, name: 'sleep' }] }),
    })

    const cancelled = await run(ctx, 'task_cancel', { task_id: entry.id })

    expect(cancelled).toMatchObject({
      ok: false,
      status: 'cancel_incomplete',
      survivors: [{ pid: 991, name: 'sleep' }],
    })
    expect(cancelled.hint).toContain('991')
  })

  test('exec refuses a command that detaches itself and starts nothing', async () => {
    const ctx = makeCtx(registry)
    const refused = await run(ctx, 'exec', {
      command: `nohup touch ${join(TEST_DIR, 'ran')} > export.log 2>&1 &`,
      background: true,
    })
    expect(refused.error).toContain('detaches itself')
    expect(refused.error).toContain('background: true')
    expect(refused.task_id).toBeUndefined()
    expect(registry.listRunning()).toEqual([])
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(join(TEST_DIR, 'ran'))).toBe(false)
  })

  test('killAll also stops what a finished command detached with &', async () => {
    // exec refuses these, so register the shell directly to cover the safety net.
    const pidFile = join(TEST_DIR, 'child.pid')
    const handle = sandboxExecAsync({
      command: `sleep 30 > /dev/null 2>&1 & echo $! > ${pidFile}`,
      workspaceDir: TEST_DIR,
    })
    registry.register('detaching shell', handle)
    await handle.done
    const childPid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(() => process.kill(childPid, 0)).not.toThrow()

    registry.killAll()
    await new Promise((r) => setTimeout(r, 300))
    expect(() => process.kill(childPid, 0)).toThrow()
  })
})

describe('output files', () => {
  test('a finished shell task leaves a log with header and footer', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 0.1; exit 3', background: true })
    await run(ctx, 'wait', { task_ids: [started.task_id], timeout_ms: 10_000 })
    await new Promise((r) => setTimeout(r, 20))
    const log = readFileSync(join(TEST_DIR, started.output_file), 'utf-8')
    expect(log).toContain(`task_id: ${started.task_id}`)
    expect(log).toContain('source: shell')
    expect(log).toContain('status: failed')
    expect(log).toContain('exit_code: 3')
  })
})

describe('legacy tools', () => {
  test('exec_wait, exec_list, agent_status and agent_result stay executable but hidden', () => {
    const tools = createTools(makeCtx(registry))
    for (const name of HIDDEN_LEGACY_TOOLS) {
      const tool = tools.find((t) => t.name === name) as any
      if (!tool) continue
      expect(tool.hidden).toBe(true)
    }
    for (const name of ['wait', 'task_list', 'task_cancel']) {
      const tool = tools.find((t) => t.name === name) as any
      expect(tool).toBeDefined()
      expect(tool.hidden).toBeUndefined()
    }
  })

  test('exec_wait still settles a task by run id', async () => {
    const ctx = makeCtx(registry)
    const started = await run(ctx, 'exec', { command: 'sleep 0.1', background: true })
    const res = await run(ctx, 'exec_wait', { run_id: started.run_id, timeout_ms: 10_000 })
    expect(res.exitCode).toBe(0)
  })
})

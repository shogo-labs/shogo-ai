// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-141 (#1634), red first: a background task the runtime kill-sweeps is not
 * a success, and its verdict must not be inferred from the number that comes
 * back from the kill. `sh -c 'sleep 30; exit 7' | tail -1` is killed by the
 * restart and reported `completed (exit code 0)` — the 0 belongs to `tail`.
 *
 * The verdict is decided by intent (user Stop / runtime shutdown / signal), and
 * it survives the restart through both restore paths.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskRegistry, formatTaskNotification, settleOutcome } from '../task-registry'
import { sandboxExecAsync } from '../sandbox-exec'
import { taskOutputDir, taskOutputRoot } from '../task-output'

const IS_WINDOWS = process.platform === 'win32'

const tmpDirs: string[] = []
function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho141-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** A real command that outlives the sweep, piped exactly like the report. */
const PIPED_SLEEP = IS_WINDOWS ? 'ping -n 30 127.0.0.1 | findstr 127' : "sh -c 'sleep 30; exit 7' | tail -1"

async function registryWithRunningTask(sessionId = 's1') {
  const workspace = tmpWorkspace()
  const registry = new TaskRegistry({
    outputDir: taskOutputDir(workspace, sessionId),
    workspaceDir: workspace,
  })
  const handle = sandboxExecAsync({ command: PIPED_SLEEP, workspaceDir: workspace })
  const entry = registry.register(PIPED_SLEEP, handle)
  registry.markBackgrounded(entry.id)
  await tick(150)
  return { registry, entry, workspace, handle, sessionId }
}

describe('a runtime restart is not a success', () => {
  test('killAll settles the task as interrupted with no exit code', async () => {
    const { registry, entry } = await registryWithRunningTask()
    const notes: string[] = []
    registry.onNotification((n) => notes.push(formatTaskNotification(n)))

    registry.killAll()
    await tick(50)

    expect(entry.status).toBe('interrupted')
    expect(entry.result?.exitCode).toBeUndefined()
    const notice = formatTaskNotification(registry.buildNotification(entry))
    expect(notice).toContain('interrupted')
    expect(notice).not.toContain('(exit code')
    expect(notice).not.toContain('completed')
    // Shutdown never wakes the agent: the verdict is for the next reader.
    expect(notes).toEqual([])
  })

  test('a cleared session forgets its rows, a shutdown keeps them', async () => {
    const kept = await registryWithRunningTask()
    kept.registry.killAll()
    await tick(50)
    // The shutdown sweep leaves the verdict in place for the restart to read.
    expect(kept.registry.listAll().find((p) => p.id === kept.entry.id)?.status).toBe('interrupted')

    const cleared = await registryWithRunningTask()
    cleared.registry.killAll({ clear: true })
    await tick(50)
    // Wiping a session's history drops its tasks — nothing left to re-hydrate.
    expect(cleared.registry.listAll()).toHaveLength(0)
    expect(cleared.registry.snapshot()).toHaveLength(0)
  })

  test('the verdict survives both restore paths and never comes back completed', async () => {
    const { registry, entry, workspace } = await registryWithRunningTask()

    registry.killAll()
    await tick(50)
    const snap = registry.snapshot()
    expect(snap.find((s) => s.runId === entry.id)?.status).toBe('interrupted')

    const fromSnapshot = new TaskRegistry({ workspaceDir: workspace })
    fromSnapshot.restoreStale(snap)
    const snapped = fromSnapshot.listDock().find((p) => p.id === entry.id)
    expect(snapped?.status).toBe('interrupted')

    // The log path: the same row read back from the task log's footer.
    const fromLog = new TaskRegistry({ workspaceDir: workspace })
    fromLog.restoreFromOutputRows([
      {
        taskId: entry.id,
        source: 'shell',
        title: PIPED_SLEEP,
        startedAt: entry.startedAt,
        path: join(taskOutputDir(workspace, 's1'), `${entry.id}.log`),
        status: 'interrupted',
        finishedAt: Date.now(),
        modifiedAt: Date.now(),
      },
    ])
    expect(fromLog.get(entry.id)?.status).toBe('interrupted')
    expect(fromLog.listAll().find((p) => p.id === entry.id)?.status).toBe('interrupted')
  })

  test('a footer-less log is a task the runtime died under, not a live one', () => {
    const reg = new TaskRegistry()
    const now = Date.now()
    reg.restoreFromOutputRows([{
      taskId: 't_dead0001',
      source: 'shell',
      title: 'bun run release',
      startedAt: now - 120_000,
      path: join(tmpdir(), 'gone', 't_dead0001.log'),
      modifiedAt: now - 60_000,
    }])
    const row = reg.listDock().find((p) => p.id === 't_dead0001')
    expect(row?.status).toBe('interrupted')
    expect(row?.stale).toBe(true)
  })

  test('the verdict and its last output survive a restart that deleted the log', async () => {
    const { registry, entry, workspace } = await registryWithRunningTask()
    registry.killAll()
    await tick(50)

    // A cloud VM is re-assigned: `.shogo` is swapped for a per-VM overlay disk
    // and the task logs go with the old VM. sessions.db travels separately.
    rmSync(taskOutputRoot(workspace), { recursive: true, force: true })

    const snap = registry.snapshot()
    const restored = new TaskRegistry({ workspaceDir: workspace })
    restored.restoreStale(snap)
    const row = restored.get(entry.id)
    expect(row).toBeDefined()
    const note = formatTaskNotification(restored.buildNotification(row!))

    expect(row!.status).toBe('interrupted')
    expect(note).not.toContain('Output:')
    expect(note).toContain('output log was removed by the restart')
    expect(note).toContain('interrupted')
  })
})

describe('a notice never points at a log that is gone', () => {
  test('an existing log is still reported', async () => {
    const { registry, entry } = await registryWithRunningTask()
    registry.killAll()
    await tick(50)
    const note = formatTaskNotification(registry.buildNotification(entry))
    expect(note).toContain('Output:')
  })

  test('a missing log is named as removed, not linked', () => {
    const dir = tmpWorkspace()
    const registry = new TaskRegistry()
    registry.restoreStale([{
      runId: 't_gone0001',
      command: 'bun run release',
      pid: undefined,
      sandboxed: false,
      startedAt: Date.now() - 60_000,
      status: 'interrupted',
      finishedAt: Date.now() - 30_000,
      outputFile: join(dir, '.shogo', 'tasks', 's', 't_gone0001.log'),
    }])
    const entry = registry.get('t_gone0001')!
    expect(existsSync(entry.outputFile!)).toBe(false)
    const note = formatTaskNotification(registry.buildNotification(entry))
    expect(note).not.toContain('Output:')
    expect(note).toContain('output log was removed by the restart')
  })
})

describe('the interrupted row is not a wake, a success or a running row', () => {
  test('it is finished in the dock and never queued as a note', () => {
    const registry = new TaskRegistry()
    registry.registerTask({ source: 'subagent', title: 'explore' })
    registry.restoreStale([{
      runId: 't_int00001',
      command: 'bun test',
      pid: undefined,
      sandboxed: false,
      startedAt: Date.now() - 60_000,
      status: 'interrupted',
      finishedAt: Date.now() - 30_000,
    }])
    expect(registry.listRunning().map((p) => p.id)).not.toContain('t_int00001')
    expect(registry.listDock().find((p) => p.id === 't_int00001')?.status).toBe('interrupted')
    expect(registry.peekNotifications().some((n) => n.taskId === 't_int00001')).toBe(false)
  })

  /**
   * The snapshot a hard stop leaves behind. `shogo-ai` restarting the host does
   * not always run the shutdown sweep (`killAll`), so the last metadata write
   * is the one from while the task was alive: `status: running`, no
   * `finishedAt`. Restoring that verbatim painted a task whose process was dead
   * as running forever, and the dock offered only Dismiss — the reported bug in
   * a different disguise.
   */
  test('a snapshot still saying running restores interrupted, not live', () => {
    const registry = new TaskRegistry()
    registry.restoreStale([
      {
        runId: 't_live00001',
        command: 'sleep 900',
        pid: 4242,
        sandboxed: false,
        startedAt: Date.now() - 120_000,
        status: 'running',
      },
    ])

    const row = registry.get('t_live00001')!
    expect(row.status).toBe('interrupted')
    expect(registry.listRunning().map((p) => p.id)).not.toContain('t_live00001')
    const docked = registry.listDock().find((p) => p.id === 't_live00001')
    expect(docked?.status).toBe('interrupted')
    // Stale stays: the child cannot be polled or killed from here, so Dismiss
    // is the only honest affordance.
    expect(docked?.stale).toBe(true)
    expect(formatTaskNotification(registry.buildNotification(row))).toContain('interrupted')
  })
})

describe('settleOutcome decides by intent, never by the number alone', () => {
  test('a restart or a Stop carries no exit code, whatever the signal reports', () => {
    for (const code of [0, 137]) {
      const restarted = settleOutcome({ runtimeShutdown: true, exitCode: code })
      expect(restarted.status).toBe('interrupted')
      expect(restarted.exitCode).toBeUndefined()
      expect(settleOutcome({ cancelRequested: true, exitCode: code }).status).toBe('cancelled')
      expect(settleOutcome({ cancelRequested: true, exitCode: code }).exitCode).toBeUndefined()
      // Intent outranks the number even when both are set.
      expect(settleOutcome({ runtimeShutdown: true, killed: true, exitCode: code }).status).toBe('interrupted')
    }
    expect(settleOutcome({ runtimeShutdown: true, exitCode: 0 }).summary).toContain('runtime restarted')
  })

  test('a signal that is not a Stop is a failure with the signal code', () => {
    const killed = settleOutcome({ killed: true, exitCode: 137 })
    expect(killed.status).toBe('failed')
    expect(killed.exitCode).toBe(137)
    expect(killed.summary).toContain('killed')
  })

  test('an exit the process took on its own is judged by its code', () => {
    expect(settleOutcome({ exitCode: 0 })).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(settleOutcome({ exitCode: 7 })).toMatchObject({ status: 'failed', exitCode: 7 })
  })

  test('a masked pipeline never reports the last stage as the command exit code', () => {
    const masked = settleOutcome({ exitCode: 0, exitCodeReliable: false, shellLabel: 'cmd.exe' })
    expect(masked.exitCode).toBeUndefined()
    expect(masked.summary).toContain('pipeline status unavailable')
    expect(masked.summary).toContain('cmd.exe')
  })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-144 acceptance criterion 1, on the only platform where it can fail.
 *
 * The incident: `taskkill /F /T /PID <shell>` walks parent pids, so a child
 * started through a wrapper that has already exited — `cmd /c start …`,
 * `merge.cmd`, the wrappers Git Bash starts — was invisible to it, and
 * `task_cancel` reported `cancelled` anyway. A job object is inherited, not
 * walked, so it reaches that child; this asserts the cancel path uses it.
 *
 * Deliberately lean: it is loaded by the `test-windows` job, which does not
 * build the SDK package, so nothing here imports `gateway-tools` (whose graph
 * reaches `preview-manager` → `@shogo/shared-runtime` → the SDK's `pkg`, which
 * does not resolve there). `TaskRegistry.cancel()` is the method `task_cancel`
 * calls and the shape it reports, so this is the same verdict without the tool
 * wrapper; the tool-level assertions live in
 * `qa-sho144-cancel-truth.acceptance.test.ts`.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandboxExecAsync, type CommandHandle } from '../sandbox-exec'
import { TaskRegistry } from '../task-registry'
import { taskOutputDir } from '../task-output'

const IS_WINDOWS = process.platform === 'win32'
const TEST_DIR = '/tmp/qa-sho144-windows-tree'

/**
 * Warm the host once before the Windows specs run.
 *
 * A cold `windows-latest` runner pays tens of seconds on the first PowerShell
 * launch (payload extraction, Defender scanning the `.ps1` we just wrote), and
 * this spec spawns *nested* powershells through `cmd /c start`, so the first run
 * in a job can miss a setup window that every later run meets in about a second.
 * Measured at head `be785a85d`: runs 1-2 of a 10x probe failed on "Timed out
 * waiting for the sleeper pid" (60 s), runs 3-10 passed in 0.96-1.02 s each.
 *
 * The budget is deliberately generous because it is the cold path; the waits
 * below stay tight so a genuine spawn failure still fails fast.
 */
beforeAll(() => {
  if (!IS_WINDOWS) return
  spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], {
    stdio: 'ignore',
    timeout: 240_000,
    windowsHide: true,
  })
  spawnSync('cmd', ['/c', 'exit 0'], { stdio: 'ignore', timeout: 60_000, windowsHide: true })
}, 240_000)

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

let handles: CommandHandle[] = []
let strays: number[] = []

/** Teardown must never outbid the test: bun's default hook budget is 5 s. */
const CLEANUP_BUDGET_MS = 2_500

/** Let `work` settle, but never wait longer than `ms` for it. */
function bounded(work: Promise<unknown> | undefined, ms: number): Promise<unknown> {
  if (!work) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
    ;(timer as any)?.unref?.()
  })
  return Promise.race([work.catch(() => undefined), budget]).finally(() => clearTimeout(timer))
}

/**
 * Drop a handle whose tree this test already cancelled. The cancel is the
 * assertion; re-killing the same handle in the hook only proves it twice, and
 * on Windows that second pass is what cost `taskkill /T` plus a process-table
 * spawn per handle.
 */
function forget(handle: CommandHandle): void {
  handles = handles.filter((candidate) => candidate !== handle)
}

// A hook that overruns its budget fails the *test* it ran after, which is how
// this spec turned the required Windows shard red in the merge queue: cleanup
// was fine, it just took longer than 5 s on a loaded runner. Bound the work and
// state the budget, so a slow kill can never be reported as AC 1 failing.
afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const handle of handles.splice(0)) {
    try { handle.kill('SIGKILL') } catch { /* already gone */ }
    await bounded(handle.killTree?.({ graceMs: 0 }), CLEANUP_BUDGET_MS)
  }
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // A process still holding the directory is a leaked process, not a test
    // failure; the assertion above is what speaks for the tree.
  }
}, 30_000)

describe.skipIf(!IS_WINDOWS)('SHO-144 AC 1 — a wrapper that exited does not hide the child', () => {
  test('cancelling a powershell tree whose cmd /c wrapper is gone leaves nothing alive', async () => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    const sleeperPs1 = join(TEST_DIR, 'sleeper.ps1')
    const startPs1 = join(TEST_DIR, 'start-orphan.ps1')
    const pidFile = join(TEST_DIR, 'orphan.pid')

    // The sleeper records its own pid, so the assertion is about the process
    // that must die — not about the wrapper, which has already exited.
    writeFileSync(
      sleeperPs1,
      [`Set-Content -Path '${pidFile}' -Value $PID`, 'Start-Sleep -Seconds 600'].join('\r\n'),
      'utf8',
    )
    writeFileSync(
      startPs1,
      [
        `$null = Start-Process -FilePath cmd.exe -ArgumentList '/c','start /b powershell -NoProfile -ExecutionPolicy Bypass -File "${sleeperPs1}"' -PassThru`,
        // The script stays alive so the exec has a tree to cancel; the orphan
        // it started is already detached from it by `cmd /c start`.
        'Start-Sleep -Seconds 600',
      ].join('\r\n'),
      'utf8',
    )

    const workspaceDir = TEST_DIR
    const handle = sandboxExecAsync({
      command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${startPs1}"`,
      workspaceDir,
      sandboxConfig: { enabled: false },
    })
    handles.push(handle)
    const registry = new TaskRegistry({ outputDir: taskOutputDir(workspaceDir, 'chat-1'), workspaceDir })
    const entry = registry.register('powershell orphan tree', handle)

    await waitFor(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().length > 0,
      90_000,
      'the sleeper pid',
    )
    const sleeper = Number(readFileSync(pidFile, 'utf8').trim())
    strays.push(sleeper)
    expect(isAlive(sleeper)).toBe(true)

    const { found, survivors } = await registry.cancel(entry.id)

    expect(found).toBe(true)
    expect(survivors).toEqual([])
    await waitFor(() => !isAlive(sleeper), 30_000, 'the sleeper to die with the job')

    // The cancel above is the assertion this test exists for; re-killing the
    // same handle in the hook would only prove it a second time.
    forget(handle)
  }, 180_000)
})

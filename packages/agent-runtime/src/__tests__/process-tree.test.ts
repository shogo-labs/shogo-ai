// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-144: `task_cancel` used to say `cancelled` the moment it had *sent* a
 * kill. Containment is what makes the word true — it kills the whole tree and
 * then reports what is still alive.
 *
 * The POSIX half is the incident's shape: an exec shell that exits while the
 * command it started keeps running in the same process group. The group is real,
 * so `kill(-pgid)` works only while somebody looks for it, and nothing looked.
 *
 * The Windows half cannot run here; it lives under `describe.skipIf(!IS_WINDOWS)`
 * and is part of the `test-windows` CI job (`process-tree.test.ts` is in its
 * path filter and its step list).
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChildLedger } from '@shogo-ai/sdk/child-ledger'
import { containChild, survivorHint, type Containment } from '../process-tree'

const IS_WINDOWS = process.platform === 'win32'

/**
 * Warm the host once before the Windows specs run.
 *
 * The first PowerShell launch on a cold `windows-latest` runner costs tens of
 * seconds (payload extraction plus Defender scanning the script we just wrote),
 * while every later launch costs about a second. Measured at head `be785a85d`:
 * runs 1-2 of a 10x probe timed out waiting for the wrapper pid file, runs 3-10
 * passed with the same body in ~1 s. Warming once here keeps the per-test waits
 * tight enough that a real spawn failure still fails fast.
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

const children: ChildProcess[] = []
const dirs: string[] = []
const containments: Containment[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-proctree-'))
  dirs.push(dir)
  return dir
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function contain(
  child: ChildProcess,
  opts: { label?: string; workspaceDir?: string; ledger?: boolean } = {},
): Containment {
  const containment = containChild(child, {
    label: opts.label ?? 'exec',
    workspaceDir: opts.workspaceDir,
    ledger: opts.ledger,
  })
  containments.push(containment)
  return containment
}

/**
 * On Windows a `killTree` costs `taskkill /T` plus process-table spawns, which
 * can exceed bun's 5 s default hook budget on a loaded runner (SHO-144: the
 * same shape of test failed in the merge queue by timing out its teardown).
 */
const CLEANUP_TIMEOUT_MS = 120_000

afterEach(async () => {
  for (const containment of containments.splice(0)) {
    try { await containment.killTree({ graceMs: 0 }) } catch { /* already gone */ }
    try { containment.dispose() } catch { /* already gone */ }
  }
  for (const child of children.splice(0)) {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}, CLEANUP_TIMEOUT_MS)

describe.skipIf(IS_WINDOWS)('containChild on POSIX', () => {
  test('killTree kills a grandchild that outlived its shell, and reports no survivors', async () => {
    // The shell exits immediately; the backgrounded sleep stays in its group.
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; exit 0'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    children.push(child)
    const containment = contain(child)

    const grandchild = await new Promise<number>((resolve) => {
      let buffered = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString()
        const match = buffered.match(/(\d+)/)
        if (match) resolve(Number(match[1]))
      })
    })
    await waitFor(() => !isAlive(child.pid as number), 5_000, 'the shell to exit')
    expect(isAlive(grandchild)).toBe(true)

    const { survivors } = await containment.killTree({ graceMs: 50 })

    expect(survivors).toEqual([])
    expect(isAlive(grandchild)).toBe(false)
  })

  test('members() lists the live tree, and killTree empties it', async () => {
    const child = spawn('bash', ['-c', 'sleep 600 & sleep 600'], {
      detached: true,
      stdio: 'ignore',
    })
    children.push(child)
    const containment = contain(child)

    await waitFor(() => containment.members().length > 0, 5_000, 'a child of the shell')
    const before = containment.members()
    expect(before.length).toBeGreaterThan(0)
    for (const member of before) expect(member.pid).not.toBe(child.pid)

    const { survivors } = await containment.killTree({ graceMs: 50 })

    expect(survivors).toEqual([])
    for (const member of before) {
      await waitFor(() => !isAlive(member.pid), 5_000, `child ${member.pid} to die`)
    }
  })

  test('a child that called setsid is chased by pid, not left behind', async () => {
    // `os.setsid()` in-process moves the child into its own group while its
    // parent chain stays intact: `kill(-pgid)` cannot reach it, so the
    // snapshot-then-kill-by-pid path is what has to save us.
    const child = spawn(
      'bash',
      ['-c', 'python3 -c "import os,time; os.setsid(); time.sleep(600)" & echo $!; wait'],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    children.push(child)
    const containment = contain(child)

    const escapee = await new Promise<number>((resolve) => {
      let buffered = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString()
        const match = buffered.match(/(\d+)/)
        if (match) resolve(Number(match[1]))
      })
    })
    await waitFor(() => containment.members().some((m) => m.pid === escapee), 5_000, 'the escapee to appear')

    const { survivors } = await containment.killTree({ graceMs: 50 })

    // It was seen before the kill, so it is killed by pid — and if that failed
    // it is named instead of the call reporting a bare "cancelled".
    if (survivors.length === 0) {
      await waitFor(() => !isAlive(escapee), 5_000, 'the escapee to die')
    } else {
      expect(survivors.map((s) => s.pid)).toContain(escapee)
    }
  })

  test('killTree returns as soon as the tree is gone instead of serving out the grace period', async () => {
    const child = spawn('bash', ['-c', 'sleep 600 & sleep 600'], {
      detached: true,
      stdio: 'ignore',
    })
    children.push(child)
    const containment = contain(child)
    await waitFor(() => containment.members().length > 0, 5_000, 'a child of the shell')

    // `sleep` takes SIGTERM, so the tree is empty well inside the 2 s grace; a
    // cancel must not pay the whole budget for that (Planner review, SHO-144).
    const startedAt = Date.now()
    const { survivors } = await containment.killTree({ graceMs: 2_000 })
    const elapsed = Date.now() - startedAt

    expect(survivors).toEqual([])
    expect(elapsed).toBeLessThan(1_000)
  })

  test('the group is recorded in the workspace ledger and removed after a clean exit', async () => {
    const workspaceDir = tempDir()
    mkdirSync(workspaceDir, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    children.push(child)
    const containment = contain(child, { workspaceDir })

    await waitFor(
      () => readChildLedger(workspaceDir).some((entry) => entry.pid === child.pid),
      5_000,
      'the ledger entry',
    )
    const recorded = readChildLedger(workspaceDir).find((entry) => entry.pid === child.pid)
    expect(recorded?.pgid).toBe(child.pid as number)
    expect(recorded?.label).toBe('exec')
    // The fingerprint is the command line the reaper will compare against.
    expect(recorded?.commandFingerprint.length).toBeGreaterThan(0)

    const { survivors } = await containment.killTree({ graceMs: 50 })
    expect(survivors).toEqual([])
    expect(readChildLedger(workspaceDir).some((entry) => entry.pid === child.pid)).toBe(false)
  })

  test('a containment with no workspace records nothing', async () => {
    const workspaceDir = tempDir()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
    })
    children.push(child)
    contain(child, { workspaceDir, ledger: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(existsSync(join(workspaceDir, '.shogo', 'run', 'children.json'))).toBe(false)
  })
})

describe.skipIf(IS_WINDOWS)('survivorHint', () => {
  test('names the pid and the command that finishes the job', () => {
    const hint = survivorHint([{ pid: 4321, name: 'sleep' }])
    expect(hint).toContain('4321')
    expect(hint).toContain('sleep')
    expect(hint).toContain('kill -9')
    expect(survivorHint([])).toBeUndefined()
  })
})

/**
 * Windows acceptance criterion 1: a background `powershell -File x.ps1` whose
 * script starts a long-running child through an exiting `cmd /c` wrapper.
 * `taskkill /T` walks parent pids and misses exactly that child; the job object
 * does not.
 */
describe.skipIf(!IS_WINDOWS)('containChild on Windows', () => {
  test('killTree kills a child started through an exited cmd /c wrapper', async () => {
    const dir = tempDir()
    const scriptPath = join(dir, 'start-orphan.ps1')
    const pidFile = join(dir, 'orphan.pid')
    // `cmd /c start` exits immediately, so the sleeper's parent pid is gone
    // before the kill: the exact shape that survived taskkill /T in prod.
    await Bun.write(
      scriptPath,
      [
        `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','start /b powershell -NoProfile -Command "Start-Sleep -Seconds 600"' -PassThru`,
        `Set-Content -Path '${pidFile}' -Value $p.Id`,
        `Start-Sleep -Seconds 600`,
      ].join('\r\n'),
    )

    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: 'ignore' },
    )
    children.push(child)
    const containment = contain(child, { label: 'exec' })

    await waitFor(() => existsSync(pidFile), 90_000, 'the wrapper pid file')

    const { survivors } = await containment.killTree({ graceMs: 0 })

    expect(survivors).toEqual([])
  }, 180_000)

  test('a kill in flight is not disarmed by the dispose that follows it', async () => {
    const child = spawn('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 600'], {
      stdio: 'ignore',
    })
    children.push(child)
    const containment = contain(child, { label: 'exec' })
    const pid = child.pid as number

    // The real order: `handle.kill()` starts the sweep and does not await it,
    // the shell dies, and its `exit` handler disposes the containment while the
    // sweep is still running. Disarm used to clear KILL_ON_JOB_CLOSE and close
    // the handle first, which left the tree alive and reported it empty.
    const inFlight = containment.killTree({ graceMs: 0 })
    containment.dispose()

    const { survivors } = await inFlight
    expect(survivors).toEqual([])
    await waitFor(() => !isAlive(pid), 20_000, 'the shell to die with its job')
  }, 120_000)

  test('a second killTree on a tree it already emptied does not re-walk the process table', async () => {
    const child = spawn('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 600'], {
      stdio: 'ignore',
    })
    children.push(child)
    const containment = contain(child, { label: 'exec' })

    expect((await containment.killTree({ graceMs: 0 })).survivors).toEqual([])
    // What `TaskRegistry.cancel` does once the kill is reported: the job handle
    // goes away, so a later `killTree` has no job left to query.
    containment.dispose()

    const startedAt = Date.now()
    const second = await containment.killTree({ graceMs: 0 })
    const elapsed = Date.now() - startedAt

    expect(second.survivors).toEqual([])
    // Without the short-circuit this fell through to the no-job path — a 500 ms
    // settle plus a `tasklist` and a `Get-CimInstance` spawn — which is what
    // pushed the AC-1 acceptance teardown past bun's 5 s hook budget.
    expect(elapsed).toBeLessThan(1_000)
  }, 120_000)
})

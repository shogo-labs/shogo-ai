// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26, defence in depth: an agent `exec` child must lead its OWN process
 * group, so a `kill -9` / `kill -- -<pgid>` traced back from an exec child can
 * never reach the process that spawned it.
 *
 * This is the second half of the incident: the desktop app's API was killed by
 * a userland `kill -9` from a `bun dev:all` running in an agent shell. The env
 * leak that made `dev:all` target the app's port is fixed in
 * `sandbox-exec-env-isolation.test.ts`; this file locks the blast-radius
 * boundary that kept the kill from being a *group* kill.
 *
 * `sandboxExecAsync` is the path the `exec` tool actually uses
 * (packages/agent-runtime/src/gateway-tools.ts), and it is the one that spawns
 * with `detached: ownGroup` on POSIX.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sandboxExecAsync } from '../sandbox-exec'

const IS_WINDOWS = process.platform === 'win32'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(IS_WINDOWS)('agent exec process group isolation', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-pgid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('an exec child leads its own process group (pgid === its pid)', async () => {
    const handle = sandboxExecAsync({
      command: 'echo "pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d \' \')"; exec sleep 30',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    try {
      await waitFor(() => /pgid=\d+/.test(handle.stdout()), 10_000, 'the pgid probe line')
      const match = handle.stdout().match(/pid=(\d+) pgid=(\d+)/)
      expect(match).not.toBeNull()
      const childPid = Number(match![1])
      const childPgid = Number(match![2])

      // Its own group leader: setsid made pgid === pid, so it is a fresh group.
      expect(childPgid).toBe(childPid)
      expect(childPid).toBe(handle.pid!)
      // ... and therefore not the runtime's group.
      expect(childPgid).not.toBe(process.pid)
      expect(isAlive(childPid)).toBe(true)
    } finally {
      handle.kill('SIGKILL')
      await handle.done
    }
  })

  test('killing the exec child process group leaves the runtime alive', async () => {
    const handle = sandboxExecAsync({
      command: 'echo "pgid=$(ps -o pgid= -p $$ | tr -d \' \')"; exec sleep 30',
      workspaceDir: workDir,
      sandboxConfig: { enabled: false },
    })

    await waitFor(() => /pgid=\d+/.test(handle.stdout()), 10_000, 'the pgid probe line')
    const pgid = Number(handle.stdout().match(/pgid=(\d+)/)![1])
    expect(pgid).toBeGreaterThan(0)

    // The exact shape of the SHO-26 kill: signal the whole group.
    process.kill(-pgid, 'SIGKILL')

    const result = await handle.done
    expect(result.exitCode).not.toBe(0)

    // If the exec child had shared our group, this test process would be dead.
    expect(() => process.kill(process.pid, 0)).not.toThrow()
    expect(isAlive(process.pid)).toBe(true)
  })
})

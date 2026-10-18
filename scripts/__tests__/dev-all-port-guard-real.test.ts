// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26 acceptance: `bun dev:all` must not SIGKILL the running Shogo desktop
 * app's API when both are pointed at the same port.
 *
 * `dev-all-port-guard.test.ts` proves the guard with an injected pid lister.
 * This file proves it against the real thing — a real listener, the real
 * `lsof`-backed `listPidsOnPort`, the real `readProtectedPids` file contract
 * and a real `process.kill`. Without the guard the first call below would kill
 * the "desktop app" instead of warning.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { killPidsOnPort, listPidsOnPort } from '../dev-all'
import { readProtectedPids } from '../lib/protected-pids'

const IS_WINDOWS = process.platform === 'win32'
const BUN = process.execPath

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const port = server.port!
  await server.stop(true)
  return port
}

/**
 * A stand-in for the desktop app's long-lived API child.
 *
 * Readiness is detected with `listPidsOnPort`, never with a request from this
 * process: `lsof -ti:<port>` matches sockets in *every* state, so a keep-alive
 * connection would put the test's own pid on the list — and `killPidsOnPort`
 * would then SIGKILL the test runner. That is the guard's real blast radius,
 * not a quirk of the test (see the PR note on `lsof -sTCP:LISTEN`).
 */
async function spawnListener(port: number) {
  const child = Bun.spawn(
    [BUN, '-e', `Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: () => new Response('ok') })`],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  await waitFor(
    async () => (await listPidsOnPort(port)).includes(child.pid),
    10_000,
    `a listener on :${port}`,
  )
  return child
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe.skipIf(IS_WINDOWS)('killPidsOnPort against a real listener', () => {
  test('spares the pid in $SHOGO_DATA_DIR/api.pid and still clears an unprotected one', async () => {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'shogo-port-guard-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))

    const api = await spawnListener(port)
    cleanups.push(() => api.kill('SIGKILL'))

    // What the desktop app writes on every spawn (apps/desktop/src/local-server.ts).
    writeFileSync(join(dataDir, 'api.pid'), String(api.pid))

    // The lister must actually see it, or the whole test is vacuous.
    expect(await listPidsOnPort(port)).toContain(api.pid)

    const warnings: string[] = []
    const spared = await killPidsOnPort(port, {
      protectedPids: readProtectedPids({ SHOGO_DATA_DIR: dataDir }),
      log: (message) => warnings.push(message),
    })

    expect(spared.spared).toEqual([api.pid])
    expect(spared.killed).toEqual([])
    expect(warnings.join('\n')).toContain('held by the running Shogo desktop app')
    expect(isAlive(api.pid)).toBe(true)
    expect(await listPidsOnPort(port)).toContain(api.pid)

    // Once the app no longer owns the port (it quit, pid file gone), the same
    // call must clear the leftover listener exactly as before.
    rmSync(join(dataDir, 'api.pid'))

    const cleared = await killPidsOnPort(port, {
      protectedPids: readProtectedPids({ SHOGO_DATA_DIR: dataDir }),
      log: () => {},
    })

    expect(cleared.killed).toEqual([api.pid])
    await waitFor(() => !isAlive(api.pid), 5_000, 'the leftover listener to die')
    await waitFor(async () => (await listPidsOnPort(port)).length === 0, 5_000, 'the port to be released')
  }, 30_000)

  test('a pid file for a process that is gone does not block the sweep', async () => {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'shogo-port-guard-stale-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))

    const listener = await spawnListener(port)
    cleanups.push(() => listener.kill('SIGKILL'))

    // A stale pid from a previous launch (the desktop rewrites it on spawn,
    // but a crash can leave one behind).
    writeFileSync(join(dataDir, 'api.pid'), '999999')

    const result = await killPidsOnPort(port, {
      protectedPids: readProtectedPids({ SHOGO_DATA_DIR: dataDir }),
      log: () => {},
    })

    expect(result.killed).toEqual([listener.pid])
    expect(result.spared).toEqual([])
  }, 30_000)
})

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-26 acceptance: the desktop app recovers *by itself* when something in
 * userland SIGKILLs its local API, and quitting never leaves a respawned API
 * behind.
 *
 * `local-server-respawn.test.ts` proves the restart *policy* against fakes.
 * This file proves the same policy against real processes: a real child
 * server, a real `kill -9`, a real pid file and a real `/health` probe — the
 * shape of the incident (`[Desktop] API server exited: code=null,
 * signal=SIGKILL` at 05:52:17 and 08:27:51 on 2026-10-18), minus Electron.
 *
 * The `start()` implemented here is a faithful copy of what
 * `spawnApiServer()` + `bootApiServer()` do in `local-server.ts`: spawn
 * detached, write `<SHOGO_DATA_DIR>/api.pid`, clear it on exit when we still
 * own it, then wait for `/health`. The wiring that cannot be imported without
 * Electron (which promise is awaited, where the pid file is written) is
 * pinned by the source-contract block at the bottom.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LocalApiSupervisor,
  type LocalApiSupervisorOptions,
} from '../local-api-supervisor'

const BUN = process.execPath
const HEALTH_BUDGET_MS = 10_000

const FAKE_API_SOURCE = `
import { existsSync, readFileSync } from 'node:fs'

const port = Number(process.argv[2])
// SHO-60: a pid written here makes *that* child answer /health with a promise
// that never resolves — alive, serving nothing. The replacement has a
// different pid, so only the wedged child stays muted.
const muteFile = process.argv[3]

function muted() {
  try {
    return !!muteFile && existsSync(muteFile) && readFileSync(muteFile, 'utf8').trim() === String(process.pid)
  } catch {
    return false
  }
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch: (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      if (muted()) return new Promise(() => {})
      return Response.json({ ok: true, pid: process.pid })
    }
    return new Response('not found', { status: 404 })
  },
})
console.log('fake api listening on ' + port)
`

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const port = server.port!
  await server.stop(true)
  return port
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthOk(port)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`fake API never became healthy on :${port}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Rig {
  dir: string
  port: number
  pidFile: string
  supervisor: LocalApiSupervisor
  restarts: Array<{ attempt: number; pid?: number }>
  giveUps: Error[]
  spawned: Array<{ pid: number; kill: () => void }>
  cleanup: () => Promise<void>
}

/**
 * One rig per test: a real fake-API child, a real pid file, and the real
 * supervisor driving the spawn.
 */
function makeRig(
  port: number,
  overrides: Partial<LocalApiSupervisorOptions> = {},
  boot: {
    restartHealthBudgetMs?: number
    restartPort?: number
    muteFile?: string
    /** Wire the child's own `exit` to the supervisor, like local-server.ts. */
    autoRestartOnExit?: boolean
  } = {},
): Rig {
  const restartHealthBudgetMs = boot.restartHealthBudgetMs ?? 3_000
  const dir = mkdtempSync(join(tmpdir(), 'shogo-desktop-respawn-'))
  const pidFile = join(dir, 'api.pid')
  const script = join(dir, 'fake-api.ts')
  writeFileSync(script, FAKE_API_SOURCE)

  const restarts: Rig['restarts'] = []
  const giveUps: Error[] = []
  const spawned: Rig['spawned'] = []
  let current: { pid: number; kill: () => void } | null = null

  const startImpl: LocalApiSupervisorOptions['start'] = async ({ attempt }) => {
    // A restart can be pointed at a port that is deliberately occupied, which
    // is how the give-up test keeps every attempt unhealthy without racing on
    // the first boot's port.
    const targetPort = attempt === 0 ? port : (boot.restartPort ?? port)
    const args = [BUN, script, String(targetPort)]
    if (boot.muteFile) args.push(boot.muteFile)
    const child = Bun.spawn(args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Same reason as local-server.ts: its own process group, so cleanup can
      // signal the whole tree without touching the app.
      detached: true,
    })
    const entry = { pid: child.pid, kill: () => child.kill('SIGKILL') }
    spawned.push(entry)
    current = entry
    writeFileSync(pidFile, String(child.pid))

    void child.exited.then((code) => {
      // A stale child's exit must never clobber the pid of its replacement.
      if (current === entry) {
        current = null
        try {
          rmSync(pidFile)
        } catch {
          // already gone
        }
      }
      // local-server.ts wires this same event to `notifyExit()`. The tests
      // below that want to drive the exit themselves leave it off.
      if (boot.autoRestartOnExit) void supervisor.notifyExit(code, null)
    })

    try {
      // A cold boot gets the full budget; a restart has to be quick.
      await waitForHealth(targetPort, attempt === 0 ? HEALTH_BUDGET_MS : restartHealthBudgetMs)
    } catch (err) {
      entry.kill()
      throw err
    }
    return child.pid
  }

  const supervisor = new LocalApiSupervisor({
    ...overrides,
    start: startImpl,
    // The watchdog's kill, mirroring `terminateApiChild()`: signal the child
    // this rig currently owns, and let its `exit` drive the restart.
    kill:
      overrides.kill ??
      (async () => {
        const entry = current
        if (!entry) return
        try {
          process.kill(entry.pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }),
    fetchHealth: overrides.fetchHealth,
    onRestarted: (info) => restarts.push(info),
    onGiveUp: (error) => giveUps.push(error),
    log: () => {},
    policy: { backoffMs: [50], maxAttempts: 5, resetAfterMs: 60_000, ...(overrides.policy ?? {}) },
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  } as LocalApiSupervisorOptions)

  const cleanup = async () => {
    supervisor.stop()
    for (const entry of spawned) {
      try {
        entry.kill()
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }

  return { dir, port, pidFile, supervisor, restarts, giveUps, spawned, cleanup }
}

const rigs: Rig[] = []
const cleanups: Array<() => void> = []
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.cleanup()
  while (cleanups.length) cleanups.pop()!()
})

describe('desktop local API respawn (real processes)', () => {
  test('a SIGKILLed API is healthy again within 10s and the pid file follows it', async () => {
    const port = await freePort()
    const rig = makeRig(port)
    rigs.push(rig)

    await rig.supervisor.start()
    const firstPid = Number(readFileSync(rig.pidFile, 'utf8'))
    expect(isAlive(firstPid)).toBe(true)
    expect(await healthOk(port)).toBe(true)

    // The incident: a userland kill -9, no crash handler, code=null.
    const killedAt = Date.now()
    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => !isAlive(firstPid), 2_000, 'the old API to die')

    // local-server.ts wires the child's `exit` event to notifyExit(); the
    // supervisor must turn that into exactly one respawn.
    const restart = rig.supervisor.notifyExit(null, 'SIGKILL')!
    await restart

    await waitForHealth(port, HEALTH_BUDGET_MS)
    const recoveredInMs = Date.now() - killedAt

    const secondPid = Number(readFileSync(rig.pidFile, 'utf8'))
    expect(secondPid).not.toBe(firstPid)
    expect(isAlive(secondPid)).toBe(true)
    expect(rig.restarts).toEqual([{ attempt: 1, pid: secondPid }])
    expect(recoveredInMs).toBeLessThan(HEALTH_BUDGET_MS)
  }, 30_000)

  test('a child that is alive but stops answering /health is killed and restarted once', async () => {
    const port = await freePort()
    const muteDir = mkdtempSync(join(tmpdir(), 'shogo-desktop-mute-'))
    cleanups.push(() => rmSync(muteDir, { recursive: true, force: true }))
    const muteFile = join(muteDir, 'mute.pid')

    // The production probe: 100 ms socket budget stands in for the 3 s one so
    // three misses land well inside the test's patience.
    const rig = makeRig(
      port,
      {
        watchdog: { intervalMs: 50, timeoutMs: 150, failureThreshold: 3 },
        fetchHealth: async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(100),
            })
            return res.ok
          } catch {
            return false
          }
        },
      },
      { muteFile, autoRestartOnExit: true },
    )
    rigs.push(rig)

    await rig.supervisor.start()
    const firstPid = Number(readFileSync(rig.pidFile, 'utf8'))
    expect(isAlive(firstPid)).toBe(true)

    // The wedged API: the process is up and holds the port, but /health never
    // answers. Nothing fires `exit`, so only the watchdog can notice.
    writeFileSync(muteFile, String(firstPid))
    expect(await healthOk(port)).toBe(false)

    await waitUntil(() => rig.restarts.length === 1, 20_000, 'the watchdog to restart the wedged API')

    const secondPid = Number(readFileSync(rig.pidFile, 'utf8'))
    expect(secondPid).not.toBe(firstPid)
    expect(isAlive(firstPid)).toBe(false)
    expect(await healthOk(port)).toBe(true)

    // Exactly one recovery: one respawn, and so exactly one
    // `local-server:restarted` broadcast for the banner to dismiss on.
    expect(rig.restarts).toEqual([{ attempt: 1, pid: secondPid }])
    expect(rig.giveUps).toEqual([])
    expect(rig.spawned).toHaveLength(2)
  }, 40_000)

  test('after stop() the API is not respawned — quitting stays quit', async () => {
    const port = await freePort()
    const rig = makeRig(port)
    rigs.push(rig)

    await rig.supervisor.start()
    const firstPid = Number(readFileSync(rig.pidFile, 'utf8'))

    rig.supervisor.stop()
    // stopLocalServer() SIGTERMs the group; a SIGKILLed child is the harsher
    // version of the same "it went away during quit" race.
    process.kill(firstPid, 'SIGKILL')
    rig.supervisor.notifyExit(null, 'SIGKILL')

    await new Promise((r) => setTimeout(r, 750))

    expect(rig.restarts).toEqual([])
    expect(rig.spawned).toHaveLength(1)
    expect(await healthOk(port)).toBe(false)
  }, 30_000)

  test('gives up loudly and leaves no child running when restarts keep failing', async () => {
    const port = await freePort()
    const blockedPort = await freePort()
    // Something else owns the port the restart would need (a leftover stack),
    // so every restart attempt fails health and must tear its own child down.
    const squatter = Bun.serve({
      port: blockedPort,
      hostname: '127.0.0.1',
      // /health must fail, or the supervisor would read the squatter as a
      // healthy API (waitForHealth only checks `res.ok`).
      fetch: () => new Response('squatter', { status: 503 }),
    })
    cleanups.push(() => void squatter.stop(true))

    const rig = makeRig(port, {}, { restartHealthBudgetMs: 500, restartPort: blockedPort })
    rigs.push(rig)

    await rig.supervisor.start()
    const firstPid = Number(readFileSync(rig.pidFile, 'utf8'))
    expect(isAlive(firstPid)).toBe(true)

    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => !isAlive(firstPid), 2_000, 'the old API to die')

    await rig.supervisor.notifyExit(1, null)

    expect(rig.giveUps).toHaveLength(1)
    expect(rig.giveUps[0]!.message).toContain('5 restart attempts failed')
    expect(rig.supervisor.hasGivenUp).toBe(true)

    // No dead pid left advertised for the next launch.
    expect(existsSync(rig.pidFile)).toBe(false)

    // Every failed attempt tore its own child down instead of leaking one.
    for (const entry of rig.spawned) {
      if (entry.pid !== firstPid) {
        await waitUntil(() => !isAlive(entry.pid), 2_000, `attempt child ${entry.pid} to die`)
      }
    }
  }, 60_000)

  // AC3: after the policy has given up the owner of the machine can still get
  // back to a working API — that is the banner's Retry, not a relaunch.
  test('after giving up, restartNow() boots a fresh child on the real port', async () => {
    const port = await freePort()
    const blockedPort = await freePort()
    const squatter = Bun.serve({
      port: blockedPort,
      hostname: '127.0.0.1',
      fetch: () => new Response('squatter', { status: 503 }),
    })
    cleanups.push(() => void squatter.stop(true))

    const rig = makeRig(port, {}, { restartHealthBudgetMs: 500, restartPort: blockedPort })
    rigs.push(rig)

    await rig.supervisor.start()
    const firstPid = Number(readFileSync(rig.pidFile, 'utf8'))
    process.kill(firstPid, 'SIGKILL')
    await waitUntil(() => !isAlive(firstPid), 2_000, 'the old API to die')
    await rig.supervisor.notifyExit(1, null)
    expect(rig.supervisor.hasGivenUp).toBe(true)

    // RestartNow is a cold boot (attempt 0), so it goes back to the real port,
    // which the failed attempts never touched.
    const { pid } = await rig.supervisor.restartNow()

    expect(rig.supervisor.hasGivenUp).toBe(false)
    expect(pid).not.toBe(firstPid)
    expect(isAlive(pid!)).toBe(true)
    expect(await healthOk(port)).toBe(true)
    // The next launch reads this file, so it has to name the new child.
    expect(Number(readFileSync(rig.pidFile, 'utf8'))).toBe(pid!)
    expect(rig.restarts.at(-1)).toEqual({ attempt: 0, pid })
  }, 60_000)
})

/**
 * The unit and real-process tests above drive the supervisor directly. These
 * two assertions pin the parts of `local-server.ts` that cannot be imported
 * without Electron, so a future refactor cannot quietly drop them: an
 * unexpected exit reaches the supervisor, and an intentional stop is checked
 * before it does.
 */
describe('local-server wiring (source contract)', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'local-server.ts'), 'utf8')

  test("the API child's exit event goes through the stop check into the supervisor", () => {
    expect(source).toContain("child.on('exit', (code, signal) => {")
    expect(source).toContain('if (intentionalStop) {')
    expect(source).toContain('void apiSupervisor.notifyExit(code, signal)')
    // The respawn reuses the spawn path, so the pid file is rewritten.
    expect(source).toContain('function spawnApiServer(')
    expect(source).toContain('writePidFile(child.pid)')
    expect(source).toContain('await apiSupervisor.start()')
  })

  test('every boot goes through the supervisor and stop() flips the flag first', () => {
    expect(source).toContain('intentionalStop = true\n  apiSupervisor.stop()')
    // The API must never be spawned outside the supervisor, or a respawn would
    // skip the backoff/give-up policy.
    const spawnCalls = source.match(/spawn\(spec\.bunPath/g) ?? []
    expect(spawnCalls).toHaveLength(1)
    expect(source).toContain(
      'start: ({ attempt }) =>\n    bootApiServer(attempt === 0 ? MAX_HEALTH_RETRIES : RESTART_HEALTH_RETRIES)',
    )
  })

  test('SHO-60: the watchdog, the crash log and Retry are wired to real paths', () => {
    // The probe is the supervisor's, and the kill reuses the shutdown path so
    // a wedged child recovers through `exit` → `notifyExit()`.
    expect(source).toContain('fetchHealth: () => probeApiHealth()')
    expect(source).toContain('await terminateApiChild(child)')
    expect(source).toContain("logApiEvent('health_watchdog_tripped'")
    // The renderer needs the attempt under way, and the dismissal.
    expect(source).toContain("broadcastApiEvent('local-server:restarting'")
    expect(source).toContain("broadcastApiEvent('local-server:restarted'")
    expect(source).toContain("broadcastApiEvent('local-server:unavailable'")
    // Every supervisor event lands on disk, stderr included.
    expect(source).toContain("logApiEvent('spawn'")
    expect(source).toContain("logApiEvent('exit', { pid: child.pid, code, signal, stderr: apiStderrTail() })")
    expect(source).toContain('appendApiStderr(text)')
    expect(source).toContain("logApiEvent('gave_up'")
    // The Retry button.
    expect(source).toContain('export async function restartLocalApiNow(')
    expect(source).toContain('await apiSupervisor.restartNow()')
  })

  test('SHO-60: the preload and main process expose Retry and the log', () => {
    const preload = readFileSync(join(import.meta.dir, '..', 'preload.ts'), 'utf8')
    const main = readFileSync(join(import.meta.dir, '..', 'main.ts'), 'utf8')

    expect(preload).toContain("ipcRenderer.invoke('local-server:restart-now')")
    expect(preload).toContain("ipcRenderer.invoke('local-server:open-log')")
    expect(preload).toContain("ipcRenderer.on('local-server:restarting'")
    expect(main).toContain("ipcMain.handle('local-server:restart-now', () => restartLocalApiNow())")
    expect(main).toContain("ipcMain.handle('local-server:open-log', () => openApiCrashLog())")
  })
})

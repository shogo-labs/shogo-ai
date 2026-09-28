// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// PreviewManager quiesce/rehydrate (metal suspend/resume) and the
// /pool/quiesce + /pool/rehydrate fan-out in pool-lifecycle-hooks.ts.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { PreviewManager, type ApiServerPhase } from '../preview-manager'
import {
  quiesceSidecars,
  rehydrateSidecars,
  sidecarHealth,
  type SidecarControl,
} from '../pool-lifecycle-hooks'

class FakeProc extends EventEmitter {
  killed = false
  killSignals: string[] = []
  kill(signal = 'SIGTERM'): boolean {
    this.killSignals.push(signal)
    this.killed = true
    setImmediate(() => this.emit('exit', 0, signal))
    return true
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-hooks-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function mk(phase: ApiServerPhase, hasApiServer: boolean | null = true) {
  const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 38307, localMode: false }) as any
  pm.apiPhase = phase
  pm.hasApiServer = hasApiServer
  const proc = new FakeProc()
  if (phase === 'healthy' || phase === 'restarting') pm.apiServerProcess = proc
  pm.forceKillPort = async () => {}
  pm.waitForPortRelease = async () => {}
  const restarts: number[] = []
  pm.restartApiServerOnly = async () => {
    restarts.push(Date.now())
    pm.apiPhase = 'healthy'
  }
  return { pm, proc, restarts }
}

describe('PreviewManager.quiesceApiServer', () => {
  it('stops a running sidecar, frees its port and holds watchers', async () => {
    const { pm, proc } = mk('healthy')
    expect(await pm.quiesceApiServer()).toBe(true)
    expect(proc.killSignals).toEqual(['SIGTERM'])
    expect(pm.apiServerPhase).toBe('stopped')
    expect(pm.watchersPaused).toBe(true)
  })

  it('is a no-op for a project without a sidecar, but still holds watchers', async () => {
    const { pm } = mk('idle', false)
    expect(await pm.quiesceApiServer()).toBe(false)
    expect(pm.watchersPaused).toBe(true)
  })
})

describe('PreviewManager.rehydrateApiServer', () => {
  it('restarts what quiesce stopped and releases the watchers', async () => {
    const { pm, restarts } = mk('healthy')
    await pm.quiesceApiServer()
    const r = pm.rehydrateApiServer()
    expect(r.restarting).toBe(true)
    await r.restart
    expect(restarts).toHaveLength(1)
    expect(pm.apiServerPhase).toBe('healthy')
    expect(pm.watchersPaused).toBe(false)
  })

  it('restarts a sidecar that resumed crashed (snapshot from before quiesce)', async () => {
    const { pm, restarts } = mk('crashed')
    const r = pm.rehydrateApiServer()
    expect(r.restarting).toBe(true)
    await r.restart
    expect(restarts).toHaveLength(1)
  })

  it('restarts a sidecar that claims healthy but no longer answers', async () => {
    const { pm, restarts } = mk('healthy')
    pm.isApiHealthy = async () => false
    await pm.rehydrateApiServer().restart
    expect(restarts).toHaveLength(1)
  })

  it('leaves a genuinely healthy, never-quiesced sidecar alone', async () => {
    const { pm, restarts } = mk('healthy')
    pm.isApiHealthy = async () => true
    const r = pm.rehydrateApiServer()
    expect(r.restarting).toBe(false)
    await r.restart
    expect(restarts).toHaveLength(0)
  })

  it('does not resume watchers that shogo push paused', async () => {
    const { pm } = mk('healthy')
    pm.pauseWatchers()
    await pm.quiesceApiServer()
    await pm.rehydrateApiServer().restart
    expect(pm.watchersPaused).toBe(true)
  })
})

function fake(opts: {
  phase?: ApiServerPhase
  quiesce?: () => Promise<boolean>
  restart?: Promise<void>
  restarting?: boolean
}): SidecarControl & { phase: ApiServerPhase } {
  const c = {
    phase: opts.phase ?? 'healthy',
    get apiServerPhase() {
      return c.phase
    },
    quiesceApiServer: opts.quiesce ?? (async () => true),
    rehydrateApiServer: () => ({
      restarting: opts.restarting ?? true,
      restart: opts.restart ?? Promise.resolve(),
    }),
  }
  return c
}

describe('pool lifecycle fan-out', () => {
  it('quiesce reports each project and isolates failures', async () => {
    const report = await quiesceSidecars(
      new Map<string, SidecarControl>([
        ['a', fake({})],
        ['b', fake({ quiesce: async () => { throw new Error('kill failed') } })],
        ['c', fake({ quiesce: async () => false })],
      ]),
    )
    expect(report).toEqual([
      { projectId: 'a', stopped: true },
      { projectId: 'b', stopped: false, error: 'kill failed' },
      { projectId: 'c', stopped: false },
    ])
  })

  it('rehydrate waits for restarts up to waitMs and reports phases and errors', async () => {
    const ok = fake({ phase: 'restarting' })
    const okRestart = new Promise<void>((r) => setTimeout(() => { ok.phase = 'healthy'; r() }, 5))
    const report = await rehydrateSidecars(
      new Map<string, SidecarControl>([
        ['ok', { ...ok, get apiServerPhase() { return ok.phase }, rehydrateApiServer: () => ({ restarting: true, restart: okRestart }) }],
        ['bad', fake({ phase: 'crashed', restart: Promise.reject(new Error('EADDRINUSE')) })],
      ]),
      1000,
    )
    expect(report).toEqual([
      { projectId: 'ok', restarting: true, phase: 'healthy' },
      { projectId: 'bad', restarting: true, phase: 'crashed', error: 'EADDRINUSE' },
    ])
  })

  it('rehydrate with waitMs=0 answers without waiting for slow restarts', async () => {
    const slow = new Promise<void>(() => {})
    const t0 = Date.now()
    const report = await rehydrateSidecars(
      new Map<string, SidecarControl>([['slow', fake({ phase: 'restarting', restart: slow })]]),
      0,
    )
    expect(Date.now() - t0).toBeLessThan(100)
    expect(report).toEqual([{ projectId: 'slow', restarting: true, phase: 'restarting' }])
  })

  it('sidecarHealth reports phase and readiness per project', () => {
    expect(
      sidecarHealth(
        new Map<string, any>([
          ['a', { ...fake({ phase: 'healthy' }), apiServerPhase: 'healthy', getStatus: () => ({ apiReady: true }) }],
          ['b', { ...fake({ phase: 'crashed' }), apiServerPhase: 'crashed', getStatus: () => ({ apiReady: false }) }],
        ]),
      ),
    ).toEqual([
      { projectId: 'a', apiPhase: 'healthy', apiReady: true },
      { projectId: 'b', apiPhase: 'crashed', apiReady: false },
    ])
  })
})

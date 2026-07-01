// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REPRO #2 — preview API proxy returns a persistent 5xx after the API sidecar
 * dies, while the preview itself (static `dist/` on :8080) stays up. This is
 * the "API server not running / 503" pain users hit until a manual restart.
 *
 * The runtime HTTP server (:8080) and the API sidecar (`server.tsx`, :3001 or
 * dynamic) have INDEPENDENT lifecycles, so the page keeps loading while every
 * `/api/*` call fails.
 *
 * Root cause lives in PreviewManager — driven here on the REAL instance:
 *   - `apiServerPort` getter returns null when the sidecar process is dead or
 *     not yet listening                                   (preview-manager.ts:1014)
 *   - `handleCrash()` gives up after MAX_CRASH_RESTARTS (5) consecutive
 *     crashes, pinning `apiServerPhase='crashed'` and scheduling NO further
 *     restart                                             (preview-manager.ts:2991)
 *
 * The 503/502 decision itself lives in server.ts `app.all('/api/*')`
 * (lines 4153-4208). That handler is NOT exported and server.ts has heavy
 * import-time side effects, so we mirror its exact terminal branch here as
 * `proxyApiDecision` and run it against the REAL PreviewManager state.
 * (Making that handler directly testable — by exporting it / injecting the PM
 * — is part of the fix, and would let this REPRO call the real code path.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewManager } from '../preview-manager'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-503-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function mk() {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38911,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
  })
}

/**
 * Faithful mirror of server.ts `app.all('/api/*')` lines 4165-4216 INCLUDING
 * the self-heal fix: when the sidecar is `crashed`, an incoming request kicks
 * off `maybeRecoverApiServer()` before deciding the response. The 3s grace
 * poll is omitted (it only delays the same outcome); the recovery trigger is
 * the behavior we assert.
 */
async function proxyApiDecision(
  pm: PreviewManager,
  fetchImpl: (url: string) => Promise<Response> = fetch,
): Promise<{ status: number; body: any }> {
  let port = pm.apiServerPort
  if (port == null && pm.apiServerPhase === 'crashed') {
    pm.maybeRecoverApiServer()
  }
  port = pm.apiServerPort
  if (port == null) {
    return { status: 503, body: { error: 'API server not ready', phase: pm.apiServerPhase } }
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/x`)
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch {
    return { status: 502, body: { error: 'API server not responding', phase: pm.apiServerPhase } }
  }
}

/**
 * Drive the REAL `handleCrash()` past the restart cap. The restart actions are
 * stubbed to no-ops so the scheduled backoff timer can never spawn a real
 * `bun run server.tsx`; the crash-counter climb is synchronous and is all we
 * need to reach the give-up state.
 */
function crashUntilGivenUp(m: any) {
  m.killApiServer = async () => {}
  m.forceKillPort = async () => {}
  m.waitForPortRelease = async () => {}
  m.startApiServer = async () => {}
  let guard = 0
  while (m.apiServerPhase !== 'crashed' && guard++ < 50) {
    m.handleCrash()
  }
}

describe('REPRO #2 — API proxy 503 after crash-beyond-recovery', () => {
  it('apiServerPort is null when no sidecar process is alive (the 503 trigger)', () => {
    expect(mk().apiServerPort).toBeNull()
  })

  it('handleCrash gives up after the restart cap → apiServerPhase pinned to "crashed"', () => {
    const m = mk() as any
    crashUntilGivenUp(m)

    expect(m.apiServerPhase).toBe('crashed')
    expect(m.apiServerPort).toBeNull()

    // Idempotent give-up: another crash does NOT schedule a new restart timer.
    const timerBefore = m.crashRestartTimer
    m.handleCrash()
    expect(m.apiServerPhase).toBe('crashed')
    expect(m.crashRestartTimer).toBe(timerBefore)

    m.stop() // clears any pending backoff timer
  })

  it('FIXED: maybeRecoverApiServer revives a crashed sidecar (resets budget, re-attempts start)', () => {
    const m = mk() as any
    crashUntilGivenUp(m)
    expect(m.apiServerPhase).toBe('crashed')

    let startCalls = 0
    m.startApiServer = async () => { startCalls++ }

    const recovered = m.maybeRecoverApiServer()
    expect(recovered).toBe(true)
    expect(m.crashCount).toBe(0) // fresh budget for the next attempt
    expect(m.apiServerPhase).not.toBe('crashed') // flipped to 'restarting'/'starting'
    expect(startCalls).toBe(1)

    // No-op when not crashed, and respects an intentional stop.
    expect(m.maybeRecoverApiServer()).toBe(false)
    m.stop()
    expect((mk() as any).maybeRecoverApiServer()).toBe(false) // idle PM: nothing to recover
  })

  it('FIXED: the proxy self-heals a crashed sidecar on the next request (no longer stuck at 503)', async () => {
    const m = mk() as any
    crashUntilGivenUp(m)
    let startCalls = 0
    m.startApiServer = async () => { startCalls++ }

    const res = await proxyApiDecision(m)
    // The request triggered recovery instead of returning a terminal crash 503.
    expect(startCalls).toBe(1)
    expect(m.apiServerPhase).not.toBe('crashed')
    // While the revived sidecar is still booting the proxy reports a transient
    // "booting" 503 (phase=restarting), which the SPA retries — NOT the
    // permanent crashed 503 that previously required a manual restart.
    expect(res.status).toBe(503)
    expect(res.body.phase).toBe('restarting')

    m.stop()
  })

  it('proxy returns 502 "API server not responding" when the port is bound but the fetch fails', async () => {
    const m = mk() as any
    // Simulate "process up + listening" so the getter yields a port, then make
    // the proxied fetch reject the way a dead/mid-crash socket does (ECONNREFUSED).
    m.apiServerProcess = { killed: false, kill: () => {} }
    m.apiListening = true
    expect(m.apiServerPort).not.toBeNull()

    const res = await proxyApiDecision(m, async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
    })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('API server not responding')

    m.stop()
  })
})

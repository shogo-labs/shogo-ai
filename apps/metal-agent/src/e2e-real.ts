// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Real-image e2e: boot the ACTUAL agent-runtime container image (converted to
 * an ext4 rootfs by scripts/metal-agent/build-runtime-rootfs.sh) as a
 * Firecracker microVM in pool mode (PROJECT_ID=__POOL__, WARM_POOL_MODE=true),
 * then prove the substrate's headline capability on the real runtime:
 *
 *   1. The multi-GB Debian runtime image cold-boots under FC and its server
 *      binds :8080 and answers /health with poolMode:true (the real warm-pod
 *      contract Knative uses).
 *   2. We let it warm (boot-time workspace pre-seed) so the snapshot captures a
 *      fully-warmed runtime — the expensive state we want to freeze once.
 *   3. suspend-to-snapshot (Pause + CreateSnapshot) frees host RAM.
 *   4. restore-from-snapshot (LoadSnapshot mmap + Resume) brings it back.
 *   5. Live-RAM continuity (latency proof): a cold boot of this image takes
 *      ~10s+; a restore that answers /health in well under that (sub-2s) can
 *      only be a resume-from-RAM, not a reboot. Combined with poolMode + the
 *      pool projectId surviving the restore, that is the sleep/wake proof.
 *      (The runtime's /health is a permanent fast-path bypass returning
 *      uptime:0, so we can't use uptime as the signal — latency is the tell.)
 *
 * Note: /pool/assign of a real project is deliberately NOT exercised here — it
 * drives the agent-gateway, which needs Postgres/S3/AI-proxy reachable over the
 * WireGuard mesh (Phase 2c). This test isolates the substrate proof for the
 * real image; assign-over-mesh is validated in Phase 4.
 *
 * Run on the bare-metal host (root):
 *   METAL_ROOTFS=$WORK/img/runtime.ext4 \
 *   METAL_GUEST_INIT=/usr/local/bin/fc-init \
 *   METAL_MEM_MIB=2048 bun run src/e2e-real.ts
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { FirecrackerVMManager, type FcVmHandle } from './firecracker-vm-manager'

const ITERS = parseInt(process.env.E2E_ITERS ?? '10', 10)
// The real runtime boots a full bun server off a multi-GB rootfs; give it a
// generous cold-boot budget (per-VM rootfs copy + bun boot). Restore stays
// fast — this only bounds the very first health wait.
const BOOT_TIMEOUT_MS = parseInt(process.env.E2E_BOOT_TIMEOUT_MS ?? '120000', 10)
// Let the boot-time workspace pre-seed warm before snapshotting so the frozen
// state is representative of a real warm pod. Best-effort; the snapshot is
// valid regardless of whether the pre-seed fully finishes.
const WARM_MS = parseInt(process.env.E2E_WARM_MS ?? '75000', 10)

interface Health {
  status: string
  projectId: string
  poolMode: boolean
  uptime: number
  fast?: boolean
  gateway?: { running?: boolean }
}

interface TerminalSession {
  id: string
  cwd: string
  cols: number
  rows: number
}

async function health(url: string, timeoutMs = 2000): Promise<Health | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

async function verifyTerminalPty(url: string): Promise<TerminalSession> {
  const res = await fetch(`${url}/terminal/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols: 80, rows: 24 }),
    signal: AbortSignal.timeout(5000),
  })
  const body = await res.json().catch(() => null) as TerminalSession | { error?: { code?: string; message?: string } } | null
  if (!res.ok) {
    const err = body && 'error' in body ? body.error : undefined
    throw new Error(`terminal PTY create failed (${res.status}): ${err?.code ?? 'unknown'} ${err?.message ?? ''}`.trim())
  }
  const session = body as TerminalSession
  if (!session?.id) throw new Error('terminal PTY create returned no session id')
  const cleanup = await fetch(`${url}/terminal/sessions/${encodeURIComponent(session.id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(3000),
  })
  if (!cleanup.ok) throw new Error(`terminal PTY cleanup failed (${cleanup.status}) for ${session.id}`)
  return session
}

/**
 * Wait until /health reports pool-ready. Returns time-to-ready in ms. We accept
 * readiness as soon as the server answers 200 with poolMode:true; we separately
 * wait for the non-fast health (real uptime) before the baseline snapshot.
 */
async function waitReady(
  handle: FcVmHandle,
  isAlive: () => boolean,
  timeoutMs: number,
): Promise<number> {
  const start = performance.now()
  const deadline = start + timeoutMs
  while (performance.now() < deadline) {
    if (!isAlive()) throw new Error(`VM ${handle.id} exited before healthy`)
    const h = await health(handle.agentUrl, 800)
    if (h && h.status === 'ok') return performance.now() - start
    await Bun.sleep(config.healthIntervalMs)
  }
  throw new Error(`VM ${handle.id} never became healthy within ${timeoutMs}ms`)
}

function log(step: string, msg: string) {
  console.log(`[e2e-real] ${step.padEnd(9)} ${msg}`)
}

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((x, y) => x - y)
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1)
}

async function main() {
  const mgr = new FirecrackerVMManager()
  const report: any = {
    image: 'agent-runtime (real)',
    iters: ITERS,
    config: { memMiB: config.memMiB, vcpus: config.vcpus, rootfs: config.baseRootfs, init: config.guestInit },
    steps: {},
  }
  let handle: FcVmHandle | null = null

  try {
    log('boot', `cold-booting real runtime image (${config.baseRootfs})...`)
    let t = performance.now()
    handle = await mgr.startVM({ memoryMB: config.memMiB, cpus: config.vcpus })
    const readyMs = await waitReady(handle, () => mgr.isRunning(handle!), BOOT_TIMEOUT_MS)
    report.steps.coldBootReadyMs = Math.round(performance.now() - t)
    log('boot', `pool-ready in ${report.steps.coldBootReadyMs}ms (health ${Math.round(readyMs)}ms)`)

    let h = await health(handle.agentUrl)
    if (!h) throw new Error('no /health after boot')
    log('boot', `health status=${h.status} poolMode=${h.poolMode} projectId=${h.projectId} gatewayRunning=${h.gateway?.running}`)
    if (h.projectId !== '__POOL__') throw new Error(`expected pool mode, got projectId=${h.projectId}`)
    if (!h.poolMode) throw new Error('runtime did not come up in poolMode')
    const terminal = await verifyTerminalPty(handle.agentUrl)
    log('verify', `terminalPty: PASS session=${terminal.id} cwd=${terminal.cwd}`)
    const baseline = h

    // Let the boot-time workspace pre-seed warm so the snapshot freezes a
    // representative warm pod. Best-effort — proceed even if it's slow/partial.
    log('warm', `warming ${Math.round(WARM_MS / 1000)}s before snapshot (pre-seed)...`)
    await Bun.sleep(WARM_MS)
    const warmed = await health(handle.agentUrl)
    log('warm', `warmed poolMode=${warmed?.poolMode} gatewayRunning=${warmed?.gateway?.running}`)

    // ---- suspend/restore loop ----------------------------------------------
    const apiMs: number[] = []
    const readyMsArr: number[] = []
    let firstAfter: Health | null = null

    for (let i = 0; i < ITERS; i++) {
      t = performance.now()
      const snap = await mgr.snapshotVM(handle)
      const suspendMs = Math.round(performance.now() - t)
      if (i === 0) {
        report.snapshot = { memBytes: snap.bytesMem, stateBytes: snap.bytesState }
        report.steps.suspendMs = suspendMs
        // Prove the VM is actually gone (host RAM freed).
        const stillUp = await health(handle.agentUrl, 500)
        report.steps.vmGoneAfterSuspend = stillUp == null
        log('suspend', `mem=${(snap.bytesMem / 1e6).toFixed(0)}MB state=${snap.bytesState}B (${suspendMs}ms) freed=${stillUp == null}`)
      }

      const t0 = performance.now()
      handle = await mgr.restoreVM(snap)
      const api = performance.now() - t0
      const ready = await waitReady(handle, () => mgr.isRunning(handle!), 15000)
      apiMs.push(api)
      readyMsArr.push(api + ready)

      const after = await health(handle.agentUrl)
      if (!after) throw new Error(`no /health after restore #${i}`)
      if (i === 0) {
        firstAfter = after
        log('resume', `poolMode=${after.poolMode} project=${after.projectId} gatewayRunning=${after.gateway?.running} (api=${api.toFixed(1)}ms ready=${(api + ready).toFixed(1)}ms)`)
      }
      if (!after.poolMode || after.projectId !== '__POOL__') {
        throw new Error(`pool state lost after restore #${i}: poolMode=${after.poolMode} projectId=${after.projectId}`)
      }
    }

    report.restore = {
      apiMs: { p50: pct(apiMs, 50), p95: pct(apiMs, 95), p99: pct(apiMs, 99), samples: apiMs.map((x) => +x.toFixed(1)) },
      readyMs: { p50: pct(readyMsArr, 50), p95: pct(readyMsArr, 95), p99: pct(readyMsArr, 99), samples: readyMsArr.map((x) => +x.toFixed(1)) },
    }

    const checks: Record<string, boolean> = {
      bootedInPoolMode: baseline.poolMode === true,
      survivedRestore: firstAfter != null && firstAfter.poolMode === true && firstAfter.projectId === '__POOL__',
      // Latency proof of live-RAM resume: a reboot would cost the full cold-boot
      // budget; a restore ready in a fraction of that resumed from RAM.
      restoreFasterThanReboot: report.restore.readyMs.p95 < Math.max(2000, report.steps.coldBootReadyMs / 3),
      hostRamFreedOnSuspend: report.steps.vmGoneAfterSuspend === true,
      terminalPty: terminal.id.length > 0,
    }
    report.correctness = { baseline, warmed, firstAfter, terminal, checks }
    for (const [k, v] of Object.entries(checks)) log('verify', `${k}: ${v ? 'PASS' : 'FAIL'}`)

    const allPass = Object.values(checks).every(Boolean)
    report.slo = {
      target_ready_p95_ms: 2000,
      actual_ready_p95_ms: report.restore.readyMs.p95,
      coldBootReadyMs: report.steps.coldBootReadyMs,
      speedup: +(report.steps.coldBootReadyMs / Math.max(1, report.restore.readyMs.p50)).toFixed(1),
    }
    report.pass = allPass && report.restore.readyMs.p95 < 2000

    console.log('\n[e2e-real] ============== RESULTS ==============')
    console.log(JSON.stringify({ steps: report.steps, snapshot: report.snapshot, restore: report.restore, checks, slo: report.slo, pass: report.pass }, null, 2))
    console.log('[e2e-real] ====================================')
    console.log(`[e2e-real] HEADLINE real-image: cold-boot ${report.steps.coldBootReadyMs}ms -> restore ready p50=${report.restore.readyMs.p50}ms p95=${report.restore.readyMs.p95}ms (${report.slo.speedup}x)  correctness=${allPass ? 'PASS' : 'FAIL'}  overall=${report.pass ? 'PASS' : 'FAIL'}`)

    mkdirSync(config.work, { recursive: true })
    const out = join(config.work, `e2e-real-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(`[e2e-real] wrote ${out}`)

    if (handle) await mgr.stopVM(handle).catch(() => {})
    process.exit(report.pass ? 0 : 1)
  } catch (err: any) {
    console.error('[e2e-real] FAILED:', err?.message ?? err)
    if (handle) {
      console.error(`[e2e-real] serial log: ${handle.serialLog}`)
      try {
        const tail = await Bun.$`tail -n 40 ${handle.serialLog}`.text()
        console.error('[e2e-real] --- serial tail ---\n' + tail)
      } catch {}
      await mgr.stopVM(handle).catch(() => {})
    }
    process.exit(2)
  }
}

main()

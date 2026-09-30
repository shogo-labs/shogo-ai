// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Real-image e2e for the per-VM workspace drive (data-drive.ts, fc-init in
 * scripts/metal-agent/build-runtime-rootfs.sh). Boots the actual runtime image
 * under Firecracker and proves, from inside the guest:
 *
 *   1. /app/workspace is its own mount of ~METAL_WORKSPACE_DRIVE_MIB, separate
 *      from the root device, and the package caches are overlays on the drive.
 *   2. A write larger than the rootfs's whole free space succeeds, and the root
 *      device's usage does not move.
 *   3. `bun install` of a real dependency lands on the drive.
 *   4. Suspend, push to the durable store, delete EVERYTHING local (what a wake
 *      on another host sees), pull, restore: the files come back byte-exact and
 *      the pulled drive is still sparse.
 *   5. SIGKILL the VM: the host can still rescue the workspace off the drive.
 *   6. With the drive disabled the same image boots with the workspace on the
 *      rootfs, as before.
 *
 * Talks to the guest through its terminal PTY (the same unauthenticated
 * pool-mode endpoint e2e-real.ts probes), so no project assignment and no
 * control plane are involved.
 *
 * Run on the bare-metal host (root) via scripts/metal-agent/run-workspace-drive-e2e.sh.
 */

import { rmSync, statSync } from 'fs'
import { join } from 'path'
import { config } from './config'
import { allocatedBytes } from './disk'
import { FirecrackerVMManager, type FcVmHandle } from './firecracker-vm-manager'
import { createSnapshotStore, type SnapshotMeta } from './snapshot-store'

const BOOT_TIMEOUT_MS = parseInt(process.env.E2E_BOOT_TIMEOUT_MS ?? '180000', 10)
const BIG_MIB = parseInt(process.env.E2E_BIG_MIB ?? '6144', 10)
const PROJECT = process.env.E2E_PROJECT_ID ?? `e2e-wsdrive-${Date.now().toString(36)}`

function log(step: string, msg: string) {
  console.log(`[e2e-ws] ${step.padEnd(9)} ${msg}`)
}

function fail(msg: string): never {
  throw new Error(msg)
}

async function waitHealthy(mgr: FirecrackerVMManager, h: FcVmHandle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!mgr.isRunning(h)) fail(`VM ${h.id} exited before healthy (serial: ${h.serialLog})`)
    try {
      const res = await fetch(`${h.agentUrl}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250)
  }
  fail(`VM ${h.id} never became healthy within ${timeoutMs}ms (serial: ${h.serialLog})`)
}

/**
 * Run a shell command in the guest through a PTY session and return its output
 * and exit status. Frames: client DATA = 0x01 + bytes; server DATA = 0x81 +
 * 4-byte seq + bytes (packages/pty-core/src/pty-protocol.ts).
 */
const AUTH = { 'x-runtime-token': 'e2e' }

/** Bind the booted guest to a throwaway project so its authed routes (the PTY) open up. */
async function assign(url: string, projectId: string): Promise<void> {
  const res = await fetch(`${url}/pool/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, env: { RUNTIME_AUTH_SECRET: AUTH['x-runtime-token'], PROJECT_TIER: 'starter' } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) fail(`/pool/assign failed (${res.status}): ${await res.text()}`)
}

async function guestExec(url: string, cmd: string, timeoutMs = 120_000): Promise<{ out: string; code: number }> {
  const created = await fetch(`${url}/terminal/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ cols: 200, rows: 50 }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!created.ok) fail(`PTY create failed (${created.status}): ${await created.text()}`)
  const { id } = (await created.json()) as { id: string }
  const nonce = Math.random().toString(36).slice(2, 10)
  const endRe = new RegExp(`__END_${nonce}_(\\d+)__`)
  let buf = ''
  try {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/terminal/sessions/${id}/ws`, { headers: AUTH } as unknown as string[])
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`guest command timed out after ${timeoutMs}ms: ${cmd}\n${buf.slice(-2000)}`))
      }, timeoutMs)
      ws.onopen = () => {
        // stty -echo keeps our own command line (which contains the marker) out
        // of the output we parse.
        const line = `stty -echo; { ${cmd} ; } 2>&1; echo "__END_${nonce}_$?__"\r`
        const bytes = new TextEncoder().encode(line)
        const frame = new Uint8Array(1 + bytes.length)
        frame[0] = 0x01
        frame.set(bytes, 1)
        ws.send(frame)
      }
      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer)
        if (data[0] !== 0x81 || data.length < 5) return
        buf += new TextDecoder().decode(data.subarray(5))
        const m = endRe.exec(buf)
        if (!m) return
        clearTimeout(timer)
        ws.close()
        const start = buf.lastIndexOf('stty -echo;')
        const body = buf.slice(0, m.index)
        const out = (start >= 0 ? body.slice(body.indexOf('\n', start) + 1) : body).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').trim()
        resolve({ out, code: parseInt(m[1], 10) })
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`PTY websocket error running: ${cmd}`))
      }
    })
  } finally {
    await fetch(`${url}/terminal/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: AUTH }).catch(() => {})
  }
}

async function must(url: string, cmd: string, timeoutMs?: number): Promise<string> {
  const r = await guestExec(url, cmd, timeoutMs)
  if (r.code !== 0) fail(`guest command failed (exit ${r.code}): ${cmd}\n${r.out}`)
  return r.out
}

/** `df -B1 --output=source,size,used,avail <path>` → numbers. */
async function df(url: string, path: string): Promise<{ source: string; size: number; used: number; avail: number }> {
  const out = await must(url, `df -B1 --output=source,size,used,avail ${path} | tail -1`)
  const [source, size, used, avail] = out.trim().split(/\s+/)
  return { source, size: Number(size), used: Number(used), avail: Number(avail) }
}

const GiB = 1024 ** 3

async function main() {
  if (config.workspaceDriveMiB <= 0) fail('set METAL_WORKSPACE_DRIVE_MIB > 0 for this e2e')
  if (config.snapStore === 'none') fail('set METAL_SNAP_STORE=fs (and METAL_SNAP_STORE_DIR) for this e2e')
  const report: any = { project: PROJECT, driveMiB: config.workspaceDriveMiB, rootfs: config.baseRootfs, steps: {} }
  const mgr = new FirecrackerVMManager()
  const store = createSnapshotStore(config)
  let h: FcVmHandle | null = null

  try {
    // --- 1. boot + mount layout -------------------------------------------
    let t = performance.now()
    h = await mgr.startVM()
    await waitHealthy(mgr, h, BOOT_TIMEOUT_MS)
    await assign(h.agentUrl, `e2e-wsdrive-${Date.now().toString(36)}`)
    report.steps.bootMs = Math.round(performance.now() - t)
    if (!h.workspaceDrive) fail('startVM did not attach a workspace drive')
    log('boot', `ready in ${report.steps.bootMs}ms, drive ${h.workspaceDrive}`)

    const mounts = await must(h.agentUrl, 'findmnt -rno TARGET,SOURCE,FSTYPE | grep -E "^/(data|app/workspace|app/\\.bun/cache|app/\\.npm|app/\\.cache) "')
    log('mounts', mounts.replace(/\n/g, ' | '))
    for (const target of ['/data', '/app/workspace', '/app/.bun/cache', '/app/.npm', '/app/.cache']) {
      if (!mounts.split('\n').some((l) => l.startsWith(`${target} `))) fail(`${target} is not a mount point:\n${mounts}`)
    }
    const ws0 = await df(h.agentUrl, '/app/workspace')
    const root0 = await df(h.agentUrl, '/')
    report.steps.workspaceDf = ws0
    report.steps.rootDf = root0
    log('df', `workspace ${(ws0.size / GiB).toFixed(1)} GiB (${ws0.source}), root ${(root0.size / GiB).toFixed(1)} GiB free ${(root0.avail / GiB).toFixed(1)} GiB`)
    if (ws0.source === root0.source) fail('/app/workspace is on the root device')
    if (ws0.size < config.workspaceDriveMiB * 1024 * 1024 * 0.9) fail(`workspace is only ${ws0.size} bytes`)
    const prewarm = await must(h.agentUrl, 'ls /app/.bun/cache | wc -l')
    if (Number(prewarm) < 10) fail(`bun cache overlay lost the image's prewarmed content (${prewarm} entries)`)

    // --- 2. write more than the rootfs could ever hold ---------------------
    const bigMiB = Math.max(BIG_MIB, Math.ceil(root0.avail / (1024 * 1024)) + 1024)
    t = performance.now()
    await must(h.agentUrl, `dd if=/dev/zero of=/app/workspace/big.bin bs=4M count=${bigMiB / 4} conv=fsync status=none`, 600_000)
    report.steps.bigWrite = { mib: bigMiB, ms: Math.round(performance.now() - t) }
    const root1 = await df(h.agentUrl, '/')
    log('write', `${bigMiB} MiB in ${report.steps.bigWrite.ms}ms; root used ${((root1.used - root0.used) / 1e6).toFixed(1)} MB more`)
    if (root1.used - root0.used > 256 * 1024 * 1024) fail(`root device grew by ${root1.used - root0.used} bytes`)

    // --- 3. bun install onto the drive -------------------------------------
    await must(
      h.agentUrl,
      `mkdir -p /app/workspace/project && cd /app/workspace/project && ` +
        `printf '{"name":"wsdrive-e2e","private":true,"dependencies":{"react":"18.3.1","zod":"3.23.8"}}' > package.json && ` +
        `bun install --no-progress`,
      300_000,
    )
    const nmSrc = await must(h.agentUrl, 'findmnt -no SOURCE -T /app/workspace/project/node_modules/react')
    if (!nmSrc.includes(ws0.source.replace('/dev/', ''))) fail(`node_modules is on ${nmSrc}, not the drive ${ws0.source}`)
    log('install', `bun install ok; node_modules on ${nmSrc}`)

    const marker = `wsdrive-${PROJECT}-${Math.random().toString(36).slice(2)}`
    await must(h.agentUrl, `echo ${marker} > /app/workspace/project/marker.txt && head -c 64M /dev/urandom > /app/workspace/project/random.bin && sync`)
    const sumBefore = await must(h.agentUrl, 'cd /app/workspace/project && sha256sum marker.txt random.bin node_modules/react/package.json')
    // Drop the zero blob before suspending so the durable push is realistic
    // (the freed blocks stay allocated in the sparse file, which is the point
    // of measuring the push below).
    await must(h.agentUrl, 'rm -f /app/workspace/big.bin && sync')

    // --- 4. suspend, push, lose all local state, pull, restore -------------
    t = performance.now()
    const snap = await mgr.snapshotVM(h)
    const durable = mgr.durableRootfs(snap.rootfs)
    const meta: SnapshotMeta = {
      projectId: PROJECT,
      net: snap.net,
      vcpus: snap.vcpus,
      memoryMB: snap.memoryMB,
      bytesMem: snap.bytesMem,
      bytesState: snap.bytesState,
      createdAt: snap.createdAt,
      rootfsPath: snap.rootfs,
      rootfsArtifactPath: mgr.restoreRootfsArtifactPath(snap.rootfs),
      rootfsMode: durable.mode,
      rootfsIdentity: 'e2e-wsdrive',
      v: 1,
    }
    const driveAllocated = allocatedBytes(snap.workspaceDrive!)
    await store.push(
      { vmstate: snap.snapshotPath, mem: snap.memFilePath, rootfs: durable.path, workspaceDrive: snap.workspaceDrive },
      meta,
    )
    report.steps.push = { ms: Math.round(performance.now() - t), driveAllocatedBytes: driveAllocated }
    log('push', `suspended + pushed in ${report.steps.push.ms}ms (drive allocated ${(driveAllocated / GiB).toFixed(2)} GiB)`)

    const drivePath = snap.workspaceDrive!
    mgr.releaseRootfs(snap.rootfs)
    mgr.releaseDataDrive(drivePath)
    for (const p of [snap.snapshotPath, snap.memFilePath]) rmSync(p, { force: true })

    t = performance.now()
    const pulled = await store.pull(PROJECT, config.snapDir, 'e2e-wsdrive')
    if (!pulled?.files.workspaceDrive) fail('durable pull did not return a workspace drive')
    const pulledAllocated = allocatedBytes(pulled.files.workspaceDrive)
    report.steps.pull = {
      ms: Math.round(performance.now() - t),
      logicalBytes: statSync(pulled.files.workspaceDrive).size,
      allocatedBytes: pulledAllocated,
    }
    log('pull', `pulled in ${report.steps.pull.ms}ms (allocated ${(pulledAllocated / GiB).toFixed(2)} GiB of ${(report.steps.pull.logicalBytes / GiB).toFixed(0)})`)
    if (pulled.files.workspaceDrive !== drivePath) fail(`pulled drive landed at ${pulled.files.workspaceDrive}, vmstate expects ${drivePath}`)
    if (pulledAllocated > driveAllocated + 256 * 1024 * 1024) fail('pulled drive was written dense')

    t = performance.now()
    h = await mgr.restoreVM({ ...snap, snapshotPath: pulled.files.vmstate, memFilePath: pulled.files.mem, workspaceDrive: drivePath })
    await waitHealthy(mgr, h, 30_000)
    report.steps.restoreMs = Math.round(performance.now() - t)
    const sumAfter = await must(h.agentUrl, 'cd /app/workspace/project && sha256sum marker.txt random.bin node_modules/react/package.json')
    if (sumAfter !== sumBefore) fail(`workspace changed across the durable round-trip:\n${sumBefore}\n---\n${sumAfter}`)
    await must(h.agentUrl, `echo after-restore >> /app/workspace/project/marker.txt && sync`)
    log('restore', `restored in ${report.steps.restoreMs}ms; checksums match and the drive is writable`)

    // --- 5. crash → rescue off the drive ------------------------------------
    process.kill(h.pid, 'SIGKILL')
    await Bun.sleep(500)
    await mgr.stopVM(h, { keepRootfs: true })
    const outDir = join(config.runDir, `e2e-ws-rescue-${Date.now()}`)
    const rescued = await mgr.extractWorkspace({ rootfs: h.rootfs, workspaceDrive: h.workspaceDrive }, outDir)
    if (!rescued.source) fail('rescue found no workspace on the drive')
    const listing = Bun.spawnSync(['tar', '-xzOf', rescued.source, './project/marker.txt']).stdout.toString()
    if (!listing.includes(marker) || !listing.includes('after-restore')) fail(`rescued marker.txt is wrong: ${listing}`)
    log('rescue', `rescued source archive ${(statSync(rescued.source).size / 1e6).toFixed(1)} MB with the latest marker`)
    rmSync(outDir, { recursive: true, force: true })
    mgr.releaseRootfs(h.rootfs)
    if (h.workspaceDrive) mgr.releaseDataDrive(h.workspaceDrive)
    h = null

    // --- 6. no drive → workspace on the rootfs ------------------------------
    const noDrive = new FirecrackerVMManager({ ...config, workspaceDriveMiB: 0 })
    h = await noDrive.startVM()
    await waitHealthy(noDrive, h, BOOT_TIMEOUT_MS)
    await assign(h.agentUrl, `e2e-wsdrive-legacy-${Date.now().toString(36)}`)
    const legacy = await guestExec(h.agentUrl, 'findmnt -no TARGET /app/workspace')
    const wsLegacy = await df(h.agentUrl, '/app/workspace')
    const rootLegacy = await df(h.agentUrl, '/')
    if (h.workspaceDrive || legacy.code === 0 || wsLegacy.source !== rootLegacy.source) {
      fail(`with the drive disabled /app/workspace should be on the rootfs (findmnt: ${legacy.out})`)
    }
    log('legacy', 'drive disabled: workspace stays on the rootfs')
    await noDrive.stopVM(h)
    h = null

    await store.remove(PROJECT)
    report.ok = true
    log('result', 'PASS')
  } catch (err: any) {
    report.ok = false
    report.error = err?.message ?? String(err)
    console.error(`[e2e-ws] FAIL: ${report.error}`)
    if (h) await mgr.stopVM(h).catch(() => {})
  } finally {
    const out = join(config.work, `e2e-workspace-drive-results-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
    await Bun.write(out, JSON.stringify(report, null, 2))
    console.log(`[e2e-ws] report ${out}`)
  }
  process.exit(report.ok ? 0 : 1)
}

main()

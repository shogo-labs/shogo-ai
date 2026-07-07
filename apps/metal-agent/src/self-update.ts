// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pull-based self-update — the scalable deploy path for the node-agent fleet.
 *
 * CI publishes an immutable, versioned bundle to object storage and records a
 * per-region/channel pointer (apps/api metal-agent-release.ts). Each host learns
 * its DESIRED version either from its heartbeat response (register.ts) or from a
 * manifest URL poll (server.ts), and applies it here:
 *
 *   download bundle → verify sha256 → atomic swap into agentDir → graceful
 *   `systemctl restart metal-agent`.
 *
 * Because the unit is `KillMode=process` and the agent adopts live microVMs on
 * startup (pool.adopt), the restart keeps every assigned project running — a
 * code deploy is invisible to users. This is what makes converge-by-pull safe:
 * no SSH fan-out, no host inventory, brand-new/burst hosts converge on their own.
 *
 * The bundle layout is exactly what deploy-fleet.sh ships (tar of `src/`,
 * `package.json`, `tsconfig.json`), so the manual and automatic paths are
 * byte-identical.
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'

export interface DesiredAgent {
  version: string
  bundleUrl: string
  sha256?: string
  channel?: string
  rebuildRootfs?: boolean
}

let updating = false
export function isUpdating(): boolean {
  return updating
}

/** Process start (module load) — used for the post-boot self-update grace window. */
const START_MS = Date.now()

/**
 * Pure decision: should we update? Extracted so it's unit-testable without the
 * environment-derived config singleton. Update iff enabled, the desired release
 * is well-formed, and its version differs from what we're running.
 */
export function shouldUpdate(currentVersion: string, desired: DesiredAgent | null | undefined, enabled: boolean): boolean {
  if (!enabled) return false
  if (!desired?.version || !desired?.bundleUrl) return false
  return desired.version !== currentVersion
}

export function needsUpdate(desired?: DesiredAgent | null): boolean {
  return shouldUpdate(config.agentVersion, desired, config.selfUpdate)
}

/**
 * Apply `desired` if it's a real change. Single-flighted (one update at a time);
 * never throws (a failed update just leaves the current version running and is
 * retried on the next heartbeat/poll). Returns true when an update was applied
 * (the process is then on its way down for the restart).
 */
export async function maybeSelfUpdate(desired?: DesiredAgent | null): Promise<boolean> {
  if (!needsUpdate(desired) || updating) return false
  // Let the instance settle (finish adopting live microVMs; prove it can serve)
  // before we restart it again. Prevents an overlapping adopt+restart race and a
  // boot-loop if a bad version is published — the agent always comes up first.
  const sinceStart = Date.now() - START_MS
  if (sinceStart < config.selfUpdateSettleMs) {
    console.log(`[self-update] deferring ${desired!.version} — settling (${sinceStart}/${config.selfUpdateSettleMs}ms since start)`)
    return false
  }
  updating = true
  try {
    console.log(`[self-update] applying ${config.agentVersion} -> ${desired!.version} (channel=${desired!.channel ?? '?'})`)
    await applyUpdate(desired!)
    return true
  } catch (err: any) {
    console.error('[self-update] failed (staying on current version):', err?.message ?? err)
    return false
  } finally {
    updating = false
  }
}

/** Fetch + parse a desired-version manifest (https:// or s3://). Null on any error. */
export async function fetchManifest(url: string): Promise<DesiredAgent | null> {
  try {
    const buf = await download(url)
    const j = JSON.parse(buf.toString('utf8'))
    if (!j?.version || !j?.bundleUrl) return null
    return j as DesiredAgent
  } catch (err: any) {
    console.warn('[self-update] manifest fetch failed:', err?.message ?? err)
    return null
  }
}

// --- internals ---------------------------------------------------------------

async function applyUpdate(d: DesiredAgent): Promise<void> {
  const buf = await download(d.bundleUrl)
  if (d.sha256) {
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== d.sha256.toLowerCase()) throw new Error(`sha256 mismatch: got ${got} want ${d.sha256}`)
  }

  const stage = mkdtempSync(join(tmpdir(), 'agent-stage-'))
  try {
    const tgz = join(stage, 'bundle.tgz')
    writeFileSync(tgz, buf)
    await run('tar', ['-xzf', tgz, '-C', stage])

    const srcStage = join(stage, 'src')
    if (!existsSync(srcStage)) throw new Error('bundle missing src/ (unexpected layout)')

    // Atomic-ish swap into the install dir: replace src wholesale (drops removed
    // files), refresh manifests, stamp the version. Bun has already loaded the
    // OLD code into memory, so overwriting files under the running process is
    // safe; the new code is picked up only on the restart below.
    const dir = config.agentDir
    mkdirSync(dir, { recursive: true })
    rmSync(join(dir, 'src'), { recursive: true, force: true })
    cpSync(srcStage, join(dir, 'src'), { recursive: true })
    for (const f of ['package.json', 'tsconfig.json']) {
      if (existsSync(join(stage, f))) cpSync(join(stage, f), join(dir, f))
    }
    writeFileSync(join(dir, 'DEPLOYED_SHA'), d.version)

    if (existsSync(join(dir, 'package.json'))) {
      try {
        await run('/usr/local/bin/bun', ['install', '--production'], dir)
      } catch (err: any) {
        console.warn('[self-update] bun install failed (continuing):', err?.message ?? err)
      }
    }

    if (d.rebuildRootfs) {
      try {
        await rebuildRootfs(stage)
      } catch (err: any) {
        console.error('[self-update] rootfs rebuild failed (agent code still updated):', err?.message ?? err)
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }

  // Graceful restart: systemd (KillMode=process) SIGTERMs only this process; the
  // firecracker children survive and the fresh instance re-adopts them. Spawn
  // detached so the restart command outlives our exit.
  console.log('[self-update] restarting metal-agent to activate new code...')
  spawn('systemctl', ['restart', 'metal-agent'], { detached: true, stdio: 'ignore' }).unref()
}

/** Download a bundle/manifest from https:// (fetch) or s3://bucket/key (Bun S3). */
async function download(url: string): Promise<Buffer> {
  if (url.startsWith('s3://')) return downloadS3(url)
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function downloadS3(url: string): Promise<Buffer> {
  const m = url.match(/^s3:\/\/([^/]+)\/(.+)$/)
  if (!m) throw new Error(`bad s3 url: ${url}`)
  const [, bucket, key] = m
  // Reuse the host's existing snapshot-store S3 creds (the whole point of pull:
  // outbound auth the host already holds, no inbound access).
  const { S3Client } = require('bun') as typeof import('bun')
  const client = new S3Client({
    bucket,
    endpoint: config.s3Endpoint || undefined,
    region: config.s3Region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  })
  return Buffer.from(await client.file(key).arrayBuffer())
}

/**
 * Rebuild the golden runtime rootfs from the bundled build script when the
 * release marks a rootfs change. Best-effort: needs the script in the bundle +
 * OCIR creds/runtime image already on the host (as burst provisioning arranges).
 */
async function rebuildRootfs(stageDir: string): Promise<void> {
  const script = join(stageDir, 'scripts', 'metal-agent', 'build-runtime-rootfs.sh')
  if (!existsSync(script)) throw new Error('build-runtime-rootfs.sh not in bundle')
  await run('bash', [script])
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

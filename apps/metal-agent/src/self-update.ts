// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pull-based self-update — the scalable deploy path for the node-agent fleet.
 *
 * CI publishes an immutable, versioned bundle to object storage and records a
 * per-region/channel pointer (apps/api metal-agent-release.ts). Each host learns
 * its DESIRED version from its heartbeat response (register.ts) — the single
 * source of truth — and applies it here:
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

import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'

export interface DesiredAgent {
  version: string
  bundleUrl: string
  sha256?: string
  channel?: string
  rebuildRootfs?: boolean
  /**
   * Immutable runtime image to bake the rootfs from (e.g. `...:production-multiarch-<sha>`).
   * Unset on releases published before pinning existed; the host then falls
   * back to the moving `RUNTIME_IMAGE` tag from its env.
   */
  runtimeImage?: string
  /** Commit the pinned image must report in `/etc/shogo-runtime-revision`. */
  runtimeRevision?: string
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
 * Local marker recording the release version whose runtime image we last built
 * the golden rootfs for. Lives next to DEPLOYED_SHA in the install dir so it
 * survives restarts. Used to decouple the rootfs rebuild from the agent
 * version-change gate (see `shouldRebuildRootfs`).
 */
const ROOTFS_MARKER = 'ROOTFS_SHA'

function readRootfsMarker(): string | null {
  try {
    return readFileSync(join(config.agentDir, ROOTFS_MARKER), 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * The release version whose runtime image this host's golden rootfs was last
 * built from (the `ROOTFS_SHA` marker) — the other half of "what code is this
 * host running" alongside `config.agentVersion` (the node-agent's own code).
 * Exposed over `/version` and the heartbeat so fleet-wide rootfs skew is
 * visible from the admin panel instead of requiring `ssh root@<host> cat
 * /opt/metal-agent/ROOTFS_SHA`. `null` on a host that has never rebuilt (or
 * predates this marker).
 */
export function getRootfsSha(): string | null {
  return readRootfsMarker()
}

/** Written into the image by packages/agent-runtime/Dockerfile. */
const REVISION_FILE = '/etc/shogo-runtime-revision'
const REVISION_RE = /^[0-9a-f]{7,64}$/

/**
 * The commit the runtime image inside `image` (an ext4 file) was built from,
 * read straight out of the filesystem with debugfs so nothing is mounted.
 * `null` when the file is absent (an image built before the stamp existed),
 * holds the Dockerfile's `unknown` default, or debugfs can't read the image.
 */
export function readImageRevision(image: string): string | null {
  const r = spawnSync('debugfs', ['-R', `cat ${REVISION_FILE}`, image], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (r.error || r.status !== 0) {
    console.warn(`[self-update] debugfs could not read ${image}:`, r.error?.message ?? r.stderr?.trim())
    return null
  }
  const rev = (r.stdout ?? '').trim().toLowerCase()
  return REVISION_RE.test(rev) ? rev : null
}

const revisionCache = new Map<string, { key: string; revision: string | null }>()

/**
 * The commit the host's golden rootfs was built from, as recorded inside the
 * image itself. Unlike `getRootfsSha` (the release that asked for the rebuild),
 * this is what the pull actually returned, so it's what the release gate trusts.
 * Cached by inode and mtime: a rebuild renames a new file into place.
 */
export function getRootfsRevision(image: string = config.baseRootfs): string | null {
  let key: string
  try {
    const st = statSync(image)
    key = `${st.ino}:${st.mtimeMs}`
  } catch {
    return null
  }
  const hit = revisionCache.get(image)
  if (hit?.key === key) return hit.revision
  const revision = readImageRevision(image)
  revisionCache.set(image, { key, revision })
  return revision
}

function writeRootfsMarker(version: string): void {
  try {
    mkdirSync(config.agentDir, { recursive: true })
    writeFileSync(join(config.agentDir, ROOTFS_MARKER), version)
  } catch (err: any) {
    console.warn('[self-update] failed to stamp ROOTFS_SHA:', err?.message ?? err)
  }
}

/**
 * Pure decision: should we rebuild the golden rootfs, INDEPENDENT of whether the
 * agent code version changed?
 *
 * Why this exists: `rebuildRootfs` used to only take effect inside a version
 * update (applyUpdate). But a single commit that touches both the agent AND the
 * runtime chain publishes two releases at the SAME version — the immediate push
 * release (rebuildRootfs=false) and, ~minutes later after the runtime image
 * builds, the workflow_run release (rebuildRootfs=true). The host updates its
 * code on the first sighting of that version, so by the time the rebuild-flagged
 * release arrives the version already matches and the rebuild was silently
 * dropped (2026-07 "guest rootfs stale after agent self-update" incident).
 *
 * The fix keys the rebuild off a local ROOTFS_SHA marker instead of the code
 * version: rebuild iff the desired release asks for it AND we have not already
 * built the rootfs for that release version. This fires once per rebuild-flagged
 * version and never loops.
 */
export function shouldRebuildRootfs(
  desired: DesiredAgent | null | undefined,
  lastBuilt: string | null,
  enabled: boolean,
): boolean {
  if (!enabled) return false
  if (!desired?.version || !desired?.rebuildRootfs) return false
  return desired.version !== lastBuilt
}

/**
 * Rebuild the golden rootfs when the desired release asks for it and we have not
 * already built it for that version — WITHOUT requiring an agent code-version
 * change. Single-flighted against maybeSelfUpdate (shares `updating`). On
 * success, stamps ROOTFS_SHA and graceful-restarts so the warm pool re-warms on
 * the new base (live microVMs keep running on the old inode via dm/loop and are
 * re-adopted). Never throws. Returns true when a rebuild+restart was kicked off.
 */
export async function maybeRebuildRootfs(desired?: DesiredAgent | null): Promise<boolean> {
  if (updating) return false
  if (!shouldRebuildRootfs(desired, readRootfsMarker(), config.selfUpdate)) return false
  // Same settle window as code updates: don't rebuild while still adopting live
  // microVMs right after boot.
  const sinceStart = Date.now() - START_MS
  if (sinceStart < config.selfUpdateSettleMs) {
    console.log(
      `[self-update] deferring rootfs rebuild for ${desired!.version} — settling (${sinceStart}/${config.selfUpdateSettleMs}ms)`,
    )
    return false
  }
  updating = true
  try {
    console.log(
      `[self-update] rebuilding golden rootfs for release ${desired!.version} (version unchanged) ` +
        `from ${desired!.runtimeImage ?? '$RUNTIME_IMAGE'}`,
    )
    await rebuildRootfs(config.agentDir, desired!)
    writeRootfsMarker(desired!.version)
    console.log('[self-update] rootfs rebuilt — restarting metal-agent to re-warm the pool on the new base...')
    spawn('systemctl', ['restart', 'metal-agent'], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch (err: any) {
    // Leave the marker unset so the next heartbeat retries; keep serving on the
    // current rootfs.
    console.error('[self-update] standalone rootfs rebuild failed (will retry):', err?.message ?? err)
    return false
  } finally {
    updating = false
  }
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
    // Persist scripts/ (build-runtime-rootfs.sh) into the install dir so a later
    // standalone rootfs rebuild (maybeRebuildRootfs) can find it — the extracted
    // stage is torn down at the end of this function.
    const scriptsStage = join(stage, 'scripts')
    if (existsSync(scriptsStage)) {
      rmSync(join(dir, 'scripts'), { recursive: true, force: true })
      cpSync(scriptsStage, join(dir, 'scripts'), { recursive: true })
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
        await rebuildRootfs(stage, d)
        // Stamp the marker so the standalone path (maybeRebuildRootfs) doesn't
        // rebuild again for this same version after the restart.
        writeRootfsMarker(d.version)
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
 * release marks a rootfs change. `baseDir` holds the bundle layout (an extracted
 * update stage, or the persisted install dir for a standalone rebuild). Needs
 * the script in the bundle + OCIR creds/runtime image already on the host
 * (RUNTIME_IMAGE + DOCKER_CONFIG in the agent's env, as provisioning arranges).
 *
 * Builds to a sibling temp file and atomically renames over the live rootfs, so
 * VMs currently booted off the old base are never disturbed (their open fd / dm
 * table keeps the old inode until released); new VMs pick up the new base after
 * the restart the caller performs.
 */
async function rebuildRootfs(baseDir: string, desired: DesiredAgent): Promise<void> {
  const script = join(baseDir, 'scripts', 'metal-agent', 'build-runtime-rootfs.sh')
  if (!existsSync(script)) throw new Error('build-runtime-rootfs.sh not in bundle')
  await buildRootfsImage({
    script,
    out: config.baseRootfs,
    runtimeImage: desired.runtimeImage,
    runtimeRevision: desired.runtimeRevision,
  })
  // A host that opted into the docker class (METAL_DOCKER_ROOTFS) also rebuilds
  // that rootfs from the docker-tagged image, with dockerd's starter installed.
  if (config.dockerClass.baseRootfs) {
    await buildRootfsImage({
      script,
      out: config.dockerClass.baseRootfs,
      runtimeImage: dockerRuntimeImage(desired.runtimeImage),
      runtimeRevision: desired.runtimeRevision,
      extraEnv: { DOCKER_CLASS: '1' },
    })
  }
}

/** `repo:env-multiarch-sha` -> `repo:env-docker-multiarch-sha`. */
export function dockerRuntimeImage(image: string | undefined): string | undefined {
  const override = process.env.METAL_DOCKER_RUNTIME_IMAGE?.trim()
  if (override) return override
  if (!image) return undefined
  const idx = image.lastIndexOf(':')
  if (idx < 0) return `${image}-docker`
  const tag = image.slice(idx + 1)
  const prefix = image.slice(0, idx + 1)
  if (tag.includes('multiarch')) return `${prefix}${tag.replace('multiarch', 'docker-multiarch')}`
  return `${image}-docker`
}

export interface BuildRootfsOptions {
  script: string
  out: string
  runtimeImage?: string
  runtimeRevision?: string
  extraEnv?: Record<string, string>
}

export interface BuildRootfsDeps {
  run: (cmd: string, args: string[], cwd?: string, extraEnv?: Record<string, string>) => Promise<void>
  readRevision: (image: string) => string | null
}

/**
 * Build the rootfs into `<out>.new` and rename it over `out` only once it is
 * proven to hold the requested commit. A pinned image tag that isn't published
 * yet fails the pull, and a build whose stamped revision differs is discarded;
 * either way `out` is untouched and the caller leaves the marker unset, so the
 * next heartbeat retries.
 */
export async function buildRootfsImage(
  opts: BuildRootfsOptions,
  deps: BuildRootfsDeps = { run, readRevision: readImageRevision },
): Promise<void> {
  const tmp = `${opts.out}.new`
  const env: Record<string, string> = { OUT: tmp, ...(opts.extraEnv ?? {}) }
  if (opts.runtimeImage) env.RUNTIME_IMAGE = opts.runtimeImage
  try {
    await deps.run('bash', [opts.script], undefined, env)
    if (opts.runtimeRevision) {
      const want = opts.runtimeRevision.toLowerCase()
      const got = deps.readRevision(tmp)
      // A pinned tag may carry a short sha; the image always holds the full one.
      if (!got || !(got.startsWith(want) || want.startsWith(got))) {
        throw new Error(
          `rootfs built from ${opts.runtimeImage ?? '$RUNTIME_IMAGE'} holds revision ${got ?? 'none'}, ` +
            `want ${want}; keeping the current image`,
        )
      }
    }
    renameSync(tmp, opts.out)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function run(cmd: string, args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: 'ignore',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

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
import { rootDiskUsage } from './disk'
import { runImageGc } from './image-gc'
import { metrics, M } from './metrics'
import { computeRootfsIdentity } from './snapshot-store'

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
  staged: string | null = null,
): boolean {
  if (!enabled) return false
  if (!desired?.version || !desired?.rebuildRootfs) return false
  return desired.version !== lastBuilt && desired.version !== staged
}

// --- runtime-image GC ---------------------------------------------------------
//
// Every rootfs rebuild pulls a fresh `shogo-runtime` image and never removes the
// old one, so `/var/lib/docker` grows ~5.7 GB per release on the ROOT disk,
// which the NVMe watermarks never look at (dal-2 filled it and could not update
// for ten days). See image-gc.ts for the collector.

/** Images this host must keep: the release image and its docker-class variant. */
export function imagesToKeep(desired?: DesiredAgent | null, extra: (string | null | undefined)[] = []) {
  const standard = desired?.runtimeImage ?? process.env.RUNTIME_IMAGE
  return [standard, dockerRuntimeImage(standard), ...extra]
}

export type ImageGcFn = (reason: string, keep: (string | null | undefined)[]) => Promise<unknown>

/**
 * The collector, indirected so a test can observe WHEN it runs without a docker
 * daemon. `_setImageGc(null)` restores the real one.
 */
const defaultImageGc: ImageGcFn = async (reason, keep) => {
  const disk = rootDiskUsage('/')
  metrics.gauge(M.rootDiskUsedPct, disk.usedPct)
  metrics.gauge(M.rootDiskFreeBytes, disk.freeBytes)
  const res = await runImageGc({ reason, keep, root: '/' })
  metrics.inc(M.imageGcFailed, res.failed.length)
  metrics.inc(M.imageGcFreedBytes, Math.round(res.freedBytes))
  metrics.gauge(M.rootDiskUsedPct, res.rootDiskAfter.usedPct)
  metrics.gauge(M.rootDiskFreeBytes, res.rootDiskAfter.freeBytes)
  return res
}

let collectImages: ImageGcFn = defaultImageGc

export function _setImageGc(fn: ImageGcFn | null): void {
  collectImages = fn ?? defaultImageGc
}

/**
 * Run the collector WITHOUT taking the single-flight flag — for callers that
 * already hold it (the rebuild path). Never throws.
 */
async function collectUnderLock(reason: string, keep: (string | null | undefined)[]): Promise<void> {
  try {
    await collectImages(reason, keep)
  } catch (err: any) {
    console.warn(`[self-update] image GC (${reason}) failed:`, err?.message ?? err)
  }
}

/**
 * The unattended/opportunistic entry point: collect old runtime images, sharing
 * the single-flight `updating` flag with the rebuild and self-update paths so a
 * `docker rmi` can never run under a `build-runtime-rootfs.sh` that is
 * exporting that image. Skips (never waits) while one of those holds it.
 *
 * `force` runs unconditionally (after a successful rebuild the old images are
 * dead weight whatever the disk says); otherwise it only runs once the ROOT
 * disk crosses `config.rootDiskGcPct`, so a healthy host is not churning.
 */
export async function maybeImageGc(
  reason: string,
  keep: (string | null | undefined)[] = imagesToKeep(null),
  opts: { force?: boolean; diskPath?: string; usedPct?: number } = {},
): Promise<boolean> {
  if (updating) return false
  const used = opts.usedPct ?? rootDiskUsage(opts.diskPath ?? '/').usedPct
  if (!opts.force && used < config.rootDiskGcPct) return false
  updating = true
  try {
    await collectUnderLock(reason, keep)
    return true
  } finally {
    updating = false
  }
}


// --- staged rootfs -------------------------------------------------------------
//
// A rebuild no longer replaces the live image. It builds `<base>.staged` next to
// it and the host keeps serving on the current image while the control plane
// boots projects on the staged one and snapshots them (pre-warm). The switch
// happens on `activateRootfs` from the heartbeat: rename the staged file over the
// base, promote the pre-warmed snapshots, restart. A rename keeps size and mtime,
// so the staged file's identity is exactly the identity the host has after the
// switch, which is what makes the pre-warmed snapshots fresh on the new image.

export const STAGED_SUFFIX = '.staged'
const STAGED_MARKER = 'ROOTFS_STAGED'
/** A host that staged a rootfs but never heard `activateRootfs` switches on its own after this. */
export const SELF_ACTIVATE_AFTER_MS = 3 * 60 * 60_000

export function stagedRootfsPath(base: string): string {
  return `${base}${STAGED_SUFFIX}`
}

export interface StagedRootfs {
  /** Release the staged image was built for. */
  version: string
  /** Identity of each staged image (`computeRootfsIdentity` of the staged file). */
  identities: { standard: string; docker?: string }
  runtimeRevision?: string
  stagedAt: number
}

function readStagedMarkerIn(dir: string): StagedRootfs | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, STAGED_MARKER), 'utf8')) as StagedRootfs
    return m?.version && m.identities?.standard ? m : null
  } catch {
    return null
  }
}

/** The staged rootfs this host is holding, or null. A marker whose image is gone is ignored. */
export function getStagedRootfs(): StagedRootfs | null {
  const m = readStagedMarkerIn(config.agentDir)
  if (!m) return null
  return existsSync(stagedRootfsPath(config.baseRootfs)) ? m : null
}

function writeStagedMarker(m: StagedRootfs): void {
  mkdirSync(config.agentDir, { recursive: true })
  writeFileSync(join(config.agentDir, STAGED_MARKER), JSON.stringify(m))
}

function clearStagedMarker(): void {
  rmSync(join(config.agentDir, STAGED_MARKER), { force: true })
}

/** Pool callbacks the staging lifecycle needs; kept as hooks so this module never imports the pool. */
export interface RootfsHooks {
  /** A new staged image replaced the old one: drop staged snapshots that are not for `identities`. */
  onStaged?(identities: StagedRootfs['identities']): void
  /** About to switch: move pre-warmed snapshots for `identities` into the current cache. */
  promote?(identities: StagedRootfs['identities']): number
}

export type ActivationDecision = 'activate' | 'self-activate' | 'wait' | 'refuse'

/**
 * Pure decision: switch to the staged rootfs now? On the control plane's word
 * for exactly this version, or on our own once it has been staged for
 * SELF_ACTIVATE_AFTER_MS (an old or broken control plane must never strand a
 * release). An `activateRootfs` for any other version is refused, so a late
 * activation for a superseded build can never switch to it.
 */
export function rootfsActivationDecision(
  staged: StagedRootfs | null,
  activate: string | null | undefined,
  now: number,
): ActivationDecision {
  if (!staged) return activate ? 'refuse' : 'wait'
  if (activate === staged.version) return 'activate'
  if (now - staged.stagedAt >= SELF_ACTIVATE_AFTER_MS) return 'self-activate'
  return activate ? 'refuse' : 'wait'
}

/**
 * Rename each staged image over its live base. The standard image goes last:
 * it carries the marker that says the switch happened, so a crash in between
 * leaves a host that retries rather than one that half-switched silently.
 */
export function activateStagedImages(baseRootfs: string, dockerBaseRootfs?: string): void {
  if (dockerBaseRootfs && existsSync(stagedRootfsPath(dockerBaseRootfs))) {
    renameSync(stagedRootfsPath(dockerBaseRootfs), dockerBaseRootfs)
  }
  renameSync(stagedRootfsPath(baseRootfs), baseRootfs)
}

let lastRefusedActivation: string | null = null

/**
 * Switch to the staged rootfs when `rootfsActivationDecision` says so: rename
 * the staged images into place, promote the pre-warmed snapshots, stamp
 * ROOTFS_SHA, graceful restart. Live microVMs keep their own rootfs copies and
 * are re-adopted, so nothing running is touched. Never throws. Returns true
 * when a switch + restart was kicked off.
 */
export async function maybeActivateRootfs(
  activate: string | null | undefined,
  hooks: RootfsHooks = {},
  now = Date.now(),
): Promise<boolean> {
  if (updating) return false
  const staged = getStagedRootfs()
  const decision = rootfsActivationDecision(staged, activate, now)
  if (decision === 'wait') return false
  if (decision === 'refuse') {
    if (activate !== lastRefusedActivation) {
      lastRefusedActivation = activate ?? null
      console.warn(
        `[self-update] refusing activateRootfs=${activate}: staged rootfs is ${staged?.version ?? 'none'}`,
      )
    }
    return false
  }
  updating = true
  try {
    const s = staged!
    if (decision === 'self-activate') {
      console.warn(
        `[self-update] rootfs ${s.version} staged ${Math.round((now - s.stagedAt) / 60_000)}m ago with no ` +
          `activateRootfs from the control plane — switching on our own`,
      )
    }
    // Rename first: promoted snapshots on a host whose rename then failed would
    // look stale to the current image and be reclaimed.
    activateStagedImages(config.baseRootfs, config.dockerClass.baseRootfs || undefined)
    const promoted = hooks.promote?.(s.identities) ?? 0
    writeRootfsMarker(s.version)
    clearStagedMarker()
    console.log(
      `[self-update] activated rootfs ${s.version} (${promoted} pre-warmed snapshot(s) promoted) — restarting metal-agent...`,
    )
    spawn('systemctl', ['restart', 'metal-agent'], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch (err: any) {
    console.error('[self-update] rootfs activation failed (will retry):', err?.message ?? err)
    return false
  } finally {
    updating = false
  }
}

/**
 * Build the golden rootfs for a rebuild-flagged release and STAGE it (see the
 * staged-rootfs section above) — WITHOUT requiring an agent code-version change
 * and without restarting. Single-flighted against maybeSelfUpdate (shares
 * `updating`). On success, writes the ROOTFS_STAGED marker; a newer release
 * that arrives while one is staged rebuilds the staged image over it. Never
 * throws. Returns true when a new image was staged.
 */
export async function maybeRebuildRootfs(desired?: DesiredAgent | null, hooks: RootfsHooks = {}): Promise<boolean> {
  if (updating) return false
  if (!shouldRebuildRootfs(desired, readRootfsMarker(), config.selfUpdate, getStagedRootfs()?.version ?? null)) return false
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
    const staged = await stageRootfs(config.agentDir, desired!)
    hooks.onStaged?.(staged.identities)
    console.log(
      `[self-update] rootfs for ${staged.version} staged (identity ${staged.identities.standard}) — ` +
        'serving on the current image until activateRootfs',
    )
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

    if (d.rebuildRootfs && shouldRebuildRootfs(d, readRootfsMarker(), true, getStagedRootfs()?.version ?? null)) {
      try {
        // Staged, not switched: the restart below only swaps agent code. The
        // marker stops the standalone path rebuilding this version again.
        await stageRootfs(stage, d)
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
 * Build the golden runtime rootfs from the bundled build script when the
 * release marks a rootfs change, into `<base>.staged` beside the live image.
 * `baseDir` holds the bundle layout (an extracted update stage, or the
 * persisted install dir for a standalone rebuild). Needs the script in the
 * bundle + OCIR creds/runtime image already on the host (RUNTIME_IMAGE +
 * DOCKER_CONFIG in the agent's env, as provisioning arranges).
 *
 * The live image is never touched here; `maybeActivateRootfs` renames the
 * staged one into place later.
 */
export async function stageRootfs(baseDir: string, desired: DesiredAgent): Promise<StagedRootfs> {
  const script = join(baseDir, 'scripts', 'metal-agent', 'build-runtime-rootfs.sh')
  if (!existsSync(script)) throw new Error('build-runtime-rootfs.sh not in bundle')
  // The previous marker no longer describes the staged file once a rebuild starts.
  clearStagedMarker()
  const out = stagedRootfsPath(config.baseRootfs)
  const keep = imagesToKeep(desired)
  // Free space BEFORE the pull. A host at 100% (dal-2) cannot successfully pull,
  // so cleanup must not be conditional on the rebuild succeeding — and the
  // collector keeps the image we are about to build from.
  if (rootDiskUsage('/').usedPct >= config.rootDiskGcPct) {
    await collectUnderLock('pre-rebuild', keep)
  }
  await buildRootfsImage({
    script,
    out,
    runtimeImage: desired.runtimeImage,
    runtimeRevision: desired.runtimeRevision,
  })
  const identities: StagedRootfs['identities'] = { standard: computeRootfsIdentity(config, out) }
  // A host that opted into the docker class (METAL_DOCKER_ROOTFS) also rebuilds
  // that rootfs from the docker-tagged image, with dockerd's starter installed.
  if (config.dockerClass.baseRootfs) {
    const dockerOut = stagedRootfsPath(config.dockerClass.baseRootfs)
    await buildRootfsImage({
      script,
      out: dockerOut,
      runtimeImage: dockerRuntimeImage(desired.runtimeImage),
      runtimeRevision: desired.runtimeRevision,
      extraEnv: { DOCKER_CLASS: '1' },
    })
    identities.docker = computeRootfsIdentity(config, dockerOut)
  }
  const staged: StagedRootfs = {
    version: desired.version,
    identities,
    runtimeRevision: desired.runtimeRevision,
    stagedAt: Date.now(),
  }
  writeStagedMarker(staged)
  // The rebuild is done with every other image: keep only this release's.
  await collectUnderLock('post-rebuild', keep)
  return staged
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

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
import { config, type VmClass } from './config'
import { rootDiskUsage } from './disk'
import { runImageGc } from './image-gc'
import { metrics, M } from './metrics'
import { computeRootfsIdentity } from './snapshot-store'
import {
  ColdBootLedger,
  addBadRootfs as addToBadList,
  clearPrevious,
  clearWatch,
  findBadRootfs,
  latestBadRootfs,
  readBadList,
  readPrevious,
  readWatch,
  rollbackDecision,
  writeBadList,
  writePrevious,
  writeWatch,
  type BadRootfs,
  type RootfsPrevious,
  type RootfsWatch,
} from './rootfs-rollback'

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

/** Where the guest's PID 1 lives in every rootfs image (METAL_GUEST_INIT). */
export const DEFAULT_GUEST_INIT = '/usr/local/bin/fc-init'

/**
 * Where the guest's PID 1 lives: `METAL_GUEST_INIT` when the host sets it, else
 * the path the build script installs. The VM is booted with
 * `init=${config.guestInit}`, so a gate that checked a different path would
 * refuse a perfectly good image — and, because a refusal clears the staged
 * marker, rebuild the same version on every heartbeat (QA round 1 on SHO-549).
 */
export function guestInitPath(cfg: { guestInit?: string } = config): string {
  return cfg.guestInit || DEFAULT_GUEST_INIT
}

/**
 * Why `image` cannot boot, or null when it can: does it hold an executable
 * `initPath`? Read with debugfs like `readImageRevision`, so nothing is mounted
 * and the answer is about the file that will actually be booted.
 *
 * A rootfs without its guest init does not boot badly, it does not boot at all —
 * the kernel execs the init and panics with `error -2` before userspace. Staging
 * shipped one of those on 2026-11-23 (SHO-549).
 */
export function guestInitProblem(image: string, initPath: string = DEFAULT_GUEST_INIT): string | null {
  const r = spawnSync('debugfs', ['-R', `stat ${initPath}`, image], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  // debugfs exits non-zero for "File not found" on some builds and 0 on others,
  // so the mode line is the real answer either way.
  const mode = /Mode:\s*([0-7]+)/.exec(r.stdout ?? '')?.[1]
  if (r.error) return `${image}: debugfs failed (${r.error.message}) — cannot prove ${initPath} is present`
  if (!mode) return `${initPath} is not in ${image} — every VM built on it panics at boot`
  if ((parseInt(mode, 8) & 0o111) === 0) return `${initPath} in ${image} is not executable (mode ${mode})`
  return null
}

/**
 * The probe a real host uses: the configured guest init, read at call time so it
 * always matches the `init=` the next VM will boot with.
 */
export function defaultGuestInitProbe(): (image: string) => string | null {
  return (image) => guestInitProblem(image, guestInitPath())
}

/**
 * The probe every gate uses, replaceable for tests: e2fsprogs is not on a dev
 * box, and `stageRootfs` builds through this without a deps argument.
 */
let guestInitProbe: (image: string) => string | null = defaultGuestInitProbe()

export function _setGuestInitProbe(fn: ((image: string) => string | null) | null): void {
  guestInitProbe = fn ?? defaultGuestInitProbe()
}

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
 * Clearing ROOTFS_SHA is a real state: a host that never rebuilt has no marker,
 * and stamping a placeholder there would make the release gate think it had.
 */
function clearRootfsMarker(): void {
  rmSync(join(config.agentDir, ROOTFS_MARKER), { force: true })
}

// --- keeping the outgoing generation -----------------------------------------
//
// Activation is a rename, and a rename destroys the destination: before
// SHO-552 the image that had been serving was gone the instant the new one
// landed, so one bad build was unrecoverable on that host (staging 2026-11-23
// kept serving nothing until it was rebuilt by hand). Every activation now
// parks the outgoing image at `<base>.prev` first. Exactly one generation is
// kept — a second `.prev` would be an 11 GB copy nobody has ever booted, on the
// one disk where space is the failure mode.

export const PREV_SUFFIX = '.prev'

export function prevRootfsPath(base: string): string {
  return `${base}${PREV_SUFFIX}`
}

/** The generation an activation displaced (see `RootfsPrevious`). */
export function getRootfsPrev(): RootfsPrevious | null {
  return readPrevious(config.agentDir)
}

export function getRootfsWatch(): RootfsWatch | null {
  return readWatch(config.agentDir)
}

/** Generations proven unusable — never rebuilt, never re-applied. */
export function getBadRootfs(): BadRootfs[] {
  return readBadList(config.agentDir)
}

/** The most recent rejection, reported on the heartbeat as `rootfsRejected`. */
export function getRejectedRootfs(): BadRootfs | null {
  return latestBadRootfs(config.agentDir)
}

export function markRootfsBad(
  version: string,
  revision: string | null | undefined,
  reason: string,
  at = Date.now(),
): void {
  const list = addToBadList(getBadRootfs(), { version, revision: revision ?? null, reason, at })
  writeBadList(config.agentDir, list)
}

/**
 * Every cold boot the pool starts from the LIVE image, for the watch window.
 * Module state on purpose: it dies with the process, and every activation
 * restarts the process — so a window never inherits another generation's boots.
 */
export const coldBoots = new ColdBootLedger()

export function reportColdBoot(ok: boolean, error?: string): void {
  coldBoots.record(ok, error)
}

/**
 * The last resort before a rebuild: delete the spare generation so the pull and
 * the build have room. Only ever called when the disk is still over the GC
 * threshold with every other image already collected, and NEVER while a watch is
 * open — then `.prev` is the only image a rollback could restore. Failure here is
 * a log line, never a failed build: a host that cannot free the space is exactly
 * the host that must not skip its rootfs rebuild silently.
 */
function dropPreviousGeneration(usedPct: number): void {
  if (getRootfsWatch()) return
  const bases = [config.baseRootfs, config.dockerClass.baseRootfs].filter((b): b is string => !!b)
  for (const base of bases) {
    const prev = prevRootfsPath(base)
    if (!existsSync(prev)) continue
    try {
      const gb = statSync(prev).size / 1e9
      rmSync(prev, { force: true })
      console.warn(
        `[self-update] dropped ${prev} (${gb.toFixed(1)}GB): root disk at ${usedPct.toFixed(0)}% ` +
          `after image GC and no rootfs watch is open — no rollback target until the next activation`,
      )
    } catch (err: any) {
      console.warn(`[self-update] could not drop ${prev}:`, err?.message ?? err)
    }
  }
  clearPrevious(config.agentDir)
}

/**
 * Everything about the image currently serving, captured BEFORE the rename that
 * replaces it. The revision and identity of the outgoing file cannot be read
 * afterwards, and a rollback needs both: the revision goes into the bad list
 * (so the same build is never applied again) and the identity is what tells the
 * snapshot GC which cache entries a rollback would need.
 */
function captureOutgoingGeneration(now: number): RootfsPrevious {
  const identities: RootfsPrevious['identities'] = {}
  if (existsSync(config.baseRootfs)) {
    identities.standard = computeRootfsIdentity(config, config.baseRootfs)
  }
  if (config.dockerClass.baseRootfs && existsSync(config.dockerClass.baseRootfs)) {
    identities.docker = computeRootfsIdentity(config, config.dockerClass.baseRootfs)
  }
  let revision: string | null = null
  try {
    revision = readImageRevision(config.baseRootfs)
  } catch {
    revision = null
  }
  return { version: readRootfsMarker(), revision, identities, activatedAt: now }
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
 *
 * `rejected` is the bad list (ROOTFS_BAD): a generation already proven not to
 * boot a VM is never rebuilt. Without that, a refusal clears the staged marker
 * and the very next heartbeat rebuilds the same broken release — an 11 GB pull
 * and a build, every 30 seconds, forever (SHO-552).
 */
export function shouldRebuildRootfs(
  desired: DesiredAgent | null | undefined,
  lastBuilt: string | null,
  enabled: boolean,
  staged: string | null = null,
  rejected: BadRootfs[] = getBadRootfs(),
): boolean {
  if (!enabled) return false
  if (!desired?.version || !desired?.rebuildRootfs) return false
  if (findBadRootfs(rejected, desired.version, desired.runtimeRevision)) return false
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
  onStaged?(identities: StagedRootfs['identities']): void | Promise<unknown>
  /** About to switch: move pre-warmed snapshots for `identities` into the current cache. */
  promote?(identities: StagedRootfs['identities']): number | Promise<number>
  /** Why a staged image cannot boot, or null. Defaults to the debugfs probe. */
  guestInitProblem?(image: string): string | null
  /**
   * Boot a real VM from `image` and report why it could not become healthy, or
   * null when it did (pool.probeBoot). The static probe above only proves the
   * guest init is there; this is the only gate that says the image actually
   * serves. Absent on a host with no free slot (or in tests): the activation
   * then proceeds on the static checks with a warning, never blocks.
   */
  probeBoot?(image: string, vmClass: VmClass): Promise<string | null>
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
 * Park `base` at `base.prev` and rename the staged image over it. The standard
 * image goes last: it carries the marker that says the switch happened, so a
 * crash in between leaves a host that retries rather than one that half-switched
 * silently.
 *
 * The outgoing image is kept (SHO-552). `rename` replaces `.prev` when one is
 * already there, so exactly one generation survives and a `.prev` never
 * accumulates into a second 11 GB copy nobody has booted.
 */
export function activateStagedImages(baseRootfs: string, dockerBaseRootfs?: string): void {
  if (dockerBaseRootfs && existsSync(stagedRootfsPath(dockerBaseRootfs))) {
    keepPreviousGeneration(dockerBaseRootfs)
    renameSync(stagedRootfsPath(dockerBaseRootfs), dockerBaseRootfs)
  }
  keepPreviousGeneration(baseRootfs)
  renameSync(stagedRootfsPath(baseRootfs), baseRootfs)
}

/** `base` → `base.prev`, replacing any earlier generation. No-op if `base` is missing. */
function keepPreviousGeneration(base: string): void {
  if (!existsSync(base)) return
  renameSync(base, prevRootfsPath(base))
}

let lastRefusedActivation: string | null = null

/**
 * Boot a real VM from each staged image before the swap (SHO-552). The static
 * probe proves the guest init exists; only a boot proves the image serves, and
 * on 2026-11-23 staging swapped in one that had all its files and still could
 * not boot a single VM. Returns the first problem, or null.
 *
 * A host with no probe hook (no pool, a test) activates on the static checks
 * alone with a warning: a gate that cannot run must never be a gate that blocks.
 */
async function bootProbeStaged(s: StagedRootfs, hooks: RootfsHooks): Promise<string | null> {
  if (!hooks.probeBoot) {
    console.warn(
      `[self-update] no boot probe available — activating rootfs ${s.version} on its static checks alone`,
    )
    return null
  }
  const images: Array<[VmClass, string | undefined]> = [
    ['docker', config.dockerClass.baseRootfs],
    ['standard', config.baseRootfs],
  ]
  for (const [vmClass, base] of images) {
    if (!base) continue
    const image = stagedRootfsPath(base)
    if (!existsSync(image)) continue
    const problem = await hooks.probeBoot(image, vmClass)
    if (problem) return `${vmClass} image: ${problem}`
  }
  return null
}

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
    // A generation already proven unusable is never re-applied — not on the
    // control plane's word, not on our own (SHO-552). The staged file stays for
    // inspection; the marker goes so the heartbeat stops retrying it.
    const bad = findBadRootfs(getBadRootfs(), s.version, s.runtimeRevision)
    if (bad) {
      if (lastRefusedActivation !== s.version) {
        lastRefusedActivation = s.version
        console.error(
          `[self-update] REFUSING to activate rootfs ${s.version}: marked bad at ` +
            `${new Date(bad.at).toISOString()} (${bad.reason}); live image untouched`,
        )
      }
      clearStagedMarker()
      return false
    }
    // Rename first: promoted snapshots on a host whose rename then failed would
    // look stale to the current image and be reclaimed.
    //
    // Unless a staged image cannot boot. Renaming one of those over the live image
    // is exactly how staging lost every cold boot (SHO-549), and `activateRootfs`
    // can name a file an older build left behind. Clear the staged marker so the
    // next heartbeat rebuilds, leave the live image alone, and tell the log — the
    // host keeps serving the image it has.
    const probe = hooks.guestInitProblem ?? guestInitProbe
    const unusable = [config.baseRootfs, config.dockerClass.baseRootfs]
      .filter((base): base is string => !!base)
      .map((base) => stagedRootfsPath(base))
      .filter((image) => existsSync(image))
      .map((image) => ({ image, problem: probe(image) }))
      .find((s) => s.problem)
    if (unusable) {
      console.error(
        `[self-update] REFUSING to activate rootfs ${s.version}: ${unusable.problem}. ` +
          `${unusable.image} left in place for inspection, live image untouched; ` +
          `the staged marker is cleared so the next heartbeat rebuilds`,
      )
      markRootfsBad(s.version, s.runtimeRevision, unusable.problem ?? 'cannot boot', now)
      clearStagedMarker()
      return false
    }
    // The gate that matters: a real cold boot from the staged image. Same signal
    // a bad release produces in production — `waitForHealth` never answers.
    const bootProblem = await bootProbeStaged(s, hooks)
    if (bootProblem) {
      console.error(
        `[self-update] REFUSING to activate rootfs ${s.version}: boot probe failed: ${bootProblem}. ` +
          `Live image untouched; the staged marker is cleared and ${s.version} is marked bad so it is not rebuilt`,
      )
      metrics.inc(M.rootfsBootProbeFailed)
      markRootfsBad(s.version, s.runtimeRevision, `boot probe failed: ${bootProblem}`, now)
      clearStagedMarker()
      return false
    }
    // Capture what we are about to destroy BEFORE the rename: the outgoing
    // revision (for the bad list) and its rootfs identity (for the snapshot GC)
    // cannot be read once the file is gone.
    const prev = captureOutgoingGeneration(now)
    if (!prev.identities.standard && !prev.identities.docker) {
      console.warn('[self-update] outgoing rootfs has no identity — a rollback will not spare its snapshots')
    }
    writePrevious(config.agentDir, prev)
    activateStagedImages(config.baseRootfs, config.dockerClass.baseRootfs || undefined)
    // Probation starts with the image live: every cold boot the pool starts from
    // now until `until` counts, and `maybeRollbackRootfs` undoes the swap if
    // they mostly fail.
    writeWatch(config.agentDir, {
      version: s.version,
      prevVersion: prev.version,
      activatedAt: now,
      until: now + config.rootfsWatchMs,
    })
    coldBoots.reset()
    const promoted = (await hooks.promote?.(s.identities)) ?? 0
    writeRootfsMarker(s.version)
    clearStagedMarker()
    console.log(
      `[self-update] activated rootfs ${s.version} (${promoted} pre-warmed snapshot(s) promoted; ` +
        `${Math.round(config.rootfsWatchMs / 60_000)}m watch, previous generation kept at ${prevRootfsPath(config.baseRootfs)}) ` +
        `— restarting metal-agent...`,
    )
    // Without an 'error' listener a missing systemctl is an uncaught exception in
    // the middle of an activation, not a failed restart.
    restartAgent()
    return true
  } catch (err: any) {
    console.error('[self-update] rootfs activation failed (will retry):', err?.message ?? err)
    return false
  } finally {
    updating = false
  }
}

/** Detached graceful restart. Without the 'error' listener a missing systemctl is an uncaught exception. */
export function restartAgent(): void {
  const restart = spawn('systemctl', ['restart', 'metal-agent'], { detached: true, stdio: 'ignore' })
  restart.on('error', (err) =>
    console.error('[self-update] could not restart metal-agent:', err.message),
  )
  restart.unref()
}

export interface RollbackResult {
  ok: boolean
  error?: string
}

/**
 * Put the previous generation back and delete the one that failed (SHO-552).
 *
 * The bad image is dropped rather than kept: `.prev` is the only spare the host
 * has room for, and after a rollback it has to hold the image that works. So the
 * rename over `base` destroys the bad inode, the marker goes back to the version
 * that was serving, and the bad list keeps its revision so no later heartbeat
 * rebuilds it.
 *
 * Never throws; returns why it refused instead. Used by both the automatic
 * watch (`maybeRollbackRootfs`) and an operator (`POST /admin/rollback-rootfs`).
 */
export async function rollbackRootfs(
  reason: 'auto' | 'manual',
  opts: { now?: number; restart?: () => void } = {},
): Promise<RollbackResult> {
  const now = opts.now ?? Date.now()
  const base = config.baseRootfs
  const prevPath = prevRootfsPath(base)
  const prev = getRootfsPrev()
  if (!prev) {
    return { ok: false, error: 'no ROOTFS_PREV marker — this host has nothing to roll back to' }
  }
  if (!existsSync(prevPath)) {
    return { ok: false, error: `${prevPath} is missing — this host has nothing to roll back to` }
  }
  if (updating) {
    return { ok: false, error: 'an update or rootfs build is in progress — retry when it finishes' }
  }
  updating = true
  try {
    const watch = getRootfsWatch()
    const counts = coldBoots.counts(watch?.activatedAt ?? 0)
    const total = counts.failures + counts.successes
    const badVersion = readRootfsMarker() ?? watch?.version ?? 'unknown'
    // Read the doomed image's own revision before the rename: after it, the only
    // copy is gone, and the bad list needs the revision to refuse a rebuild of
    // the same build under a different version.
    let badRevision: string | null = null
    try {
      badRevision = readImageRevision(base)
    } catch {
      badRevision = null
    }
    if (config.dockerClass.baseRootfs) {
      const dockerPrev = prevRootfsPath(config.dockerClass.baseRootfs)
      if (existsSync(dockerPrev)) renameSync(dockerPrev, config.dockerClass.baseRootfs)
    }
    renameSync(prevPath, base)
    if (prev.version) writeRootfsMarker(prev.version)
    else clearRootfsMarker()
    clearPrevious(config.agentDir)
    clearWatch(config.agentDir)
    coldBoots.reset()
    const minutes = watch ? Math.max(0, Math.round((now - watch.activatedAt) / 60_000)) : 0
    const why = `${reason} rollback: ${counts.failures}/${total} cold boots failed` +
      (counts.topError ? ` (${counts.topError})` : '')
    markRootfsBad(badVersion, badRevision, why, now)
    metrics.inc(M.rootfsRollback)
    console.log(
      `[self-update] ROLLED BACK rootfs ${badVersion} → ${prev.version ?? 'previous generation'}` +
        `${reason === 'manual' ? ' (manual)' : ''}: ${counts.failures}/${total} cold boots failed ` +
        `in ${minutes}m${counts.topError ? ` (${counts.topError})` : ''} — restarting metal-agent...`,
    )
    ;(opts.restart ?? restartAgent)()
    return { ok: true }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[self-update] rootfs rollback failed:', msg)
    return { ok: false, error: msg }
  } finally {
    updating = false
  }
}

/**
 * Called on every heartbeat tick: has the generation we just activated failed to
 * boot enough VMs to send the host back? A watch that ends with the image still
 * healthy is closed here, once, so a later failure storm is not attributed to an
 * activation from an hour ago.
 */
export async function maybeRollbackRootfs(now = Date.now()): Promise<boolean> {
  if (updating) return false
  const watch = getRootfsWatch()
  if (!watch) return false
  const counts = coldBoots.counts(watch.activatedAt)
  const decision = rollbackDecision({
    failures: counts.failures,
    successes: counts.successes,
    now,
    watch,
    minFailures: config.rootfsRollbackMinFailures,
    rate: config.rootfsRollbackRate,
  })
  if (decision === 'ok') return false
  if (decision === 'expired') {
    clearWatch(config.agentDir)
    const total = counts.failures + counts.successes
    console.log(
      `[self-update] rootfs ${watch.version} passed its watch: ${counts.failures}/${total} cold boots ` +
        `failed in ${Math.round((watch.until - watch.activatedAt) / 60_000)}m — keeping it, and releasing ${prevRootfsPath(config.baseRootfs)} to the disk`,
    )
    return false
  }
  const res = await rollbackRootfs('auto', { now })
  if (!res.ok) console.error('[self-update] automatic rollback refused:', res.error)
  return res.ok
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
    await hooks.onStaged?.(staged.identities)
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
  //
  // A rebuild needs room for base + `.prev` + `.staged`: keeping the last good
  // image per class means each class now holds two, and the space check has to
  // count them (SHO-552). If the disk is still tight after the image GC, the
  // spare generation goes — it is the only thing here nobody is booting. Never
  // outside a watch window though: during one, `.prev` IS the rollback target.
  if (rootDiskUsage('/').usedPct >= config.rootDiskGcPct) {
    await collectUnderLock('pre-rebuild', keep)
    const after = rootDiskUsage('/').usedPct
    if (after >= config.rootDiskGcPct) dropPreviousGeneration(after)
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
  /** Why the built image cannot boot, or null. Defaults to the debugfs probe. */
  guestInitProblem?: (image: string) => string | null
}

/**
 * Build the rootfs into `<out>.new` and rename it over `out` only once it is
 * proven to hold the requested commit and a bootable guest init. A pinned image
 * tag that isn't published yet fails the pull, a build whose stamped revision
 * differs is discarded, and a build that lost `/usr/local/bin/fc-init` — the one
 * defect that makes every VM on the host panic at boot — is discarded too;
 * either way `out` is untouched and the caller leaves the marker unset, so the
 * next heartbeat retries.
 */
export async function buildRootfsImage(
  opts: BuildRootfsOptions,
  deps: BuildRootfsDeps = { run, readRevision: readImageRevision, guestInitProblem: guestInitProbe },
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
    // Belt and braces with the build script's own gate: a host whose bundle still
    // carries an older script must not ship an image it cannot boot.
    const initProblem = (deps.guestInitProblem ?? guestInitProbe)(tmp)
    if (initProblem) {
      throw new Error(`rootfs built without its guest init (${initProblem}); keeping the current image`)
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Runtime-image garbage collection.
 *
 * `build-runtime-rootfs.sh` pulls the release's `shogo-runtime` image, exports
 * it to a tar and builds the ext4 rootfs from that. It `docker rm`s the
 * container but never the image, so every rebuild leaves a ~5.7 GB image layer
 * set in `/var/lib/docker` — on the ROOT disk, not the NVMe cache the GC
 * watermarks watch. Left alone that is ~5.7 GB per release: dal-2 reached 83
 * images on a 440 GB disk, hit 100%, and every update failed with "no space
 * left on device" for ten days while the host kept serving a 10-day-old guest
 * image (2026-10-31).
 *
 * So: after a successful rebuild (and on a timer, and before a pull when the
 * root disk is already tight) keep only the release image this host actually
 * needs — the standard one, its docker-class variant, and whatever a build is
 * using right now — and drop every other `shogo-runtime` tag.
 *
 * Non-runtime images are never touched: a host may build runtime images itself
 * (`PULL=false`, `docker buildx`), and anything else on the daemon belongs to
 * somebody else.
 */

import { execFile, execFileSync } from 'child_process'
import { diskUsage, type DiskUsage } from './disk'
import { metrics, M } from './metrics'

/** One row of `docker images --format '{{json .}}'`. */
export interface DockerImageRow {
  Repository: string
  Tag: string
  ID?: string
  Size?: string
  CreatedAt?: string
}

export interface ImageGcResult {
  reason: string
  removed: string[]
  failed: { tag: string; error: string }[]
  containersPruned: number
  /** Root-disk free bytes gained (0 when unknown). */
  freedBytes: number
  rootDiskBefore: DiskUsage
  rootDiskAfter: DiskUsage
}

/** True for `.../shogo-runtime` — the repo this host's rootfs is built from. */
export function isRuntimeRepository(repo: string): boolean {
  return /(^|\/)shogo-runtime$/.test((repo ?? '').trim())
}

/** `repo:tag`, or null for a row that is not a tagged shogo-runtime image. */
export function imageRef(row: DockerImageRow): string | null {
  const repo = (row.Repository ?? '').trim()
  const tag = (row.Tag ?? '').trim()
  if (!repo || !tag || tag === '<none>' || repo === '<none>') return null
  if (!isRuntimeRepository(repo)) return null
  return `${repo}:${tag}`
}

function normalise(ref: string): string {
  return ref.trim().toLowerCase()
}

/**
 * Pure planner: which `shogo-runtime` image refs may be removed.
 *
 * `keep` holds refs (and bare tags) that must survive: the desired release's
 * image, its docker-class variant, and any image a rebuild is using. Dangling
 * images (`<none>:<none>`) are deliberately NOT returned — `docker image prune`
 * handles those, and they carry no tag to remove by name.
 */
export function planImageGc(rows: DockerImageRow[], keep: (string | null | undefined)[]): string[] {
  const keepSet = new Set(
    keep.filter((k): k is string => !!k && !!k.trim()).map((k) => normalise(k)),
  )
  const keepTags = new Set(
    [...keepSet].map((k) => (k.includes('/') ? k.slice(k.lastIndexOf(':') + 1) : k)).filter((t) => !!t),
  )
  const out: string[] = []
  for (const row of rows) {
    const ref = imageRef(row)
    if (!ref) continue
    if (keepSet.has(normalise(ref))) continue
    // A caller that only knows the tag (e.g. `production-multiarch-abc`) still
    // protects that image.
    if (keepTags.has(normalise(row.Tag))) continue
    if (!out.includes(ref)) out.push(ref)
  }
  return out
}

/** Parse the newline-delimited JSON that `docker images --format '{{json .}}'` emits. */
export function parseImageList(stdout: string): DockerImageRow[] {
  const rows: DockerImageRow[] = []
  for (const line of (stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const row = JSON.parse(t) as DockerImageRow
      if (row && typeof row.Repository === 'string' && typeof row.Tag === 'string') rows.push(row)
    } catch {
      /* a truncated/garbled line must not stop the sweep */
    }
  }
  return rows
}

export interface ImageGcDeps {
  /** Run a command, returning stdout. Rejects on a non-zero exit. */
  exec: (cmd: string, args: string[]) => Promise<string>
  disk: (path: string) => DiskUsage
}

const defaultDeps: ImageGcDeps = {
  exec: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)))
        else resolve(stdout ?? '')
      })
    }),
  disk: diskUsage,
}

/** Does this host have a docker daemon at all? */
export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const CONTAINER_LABEL = 'shogo-rootfs-build=1'

/**
 * Remove every `shogo-runtime` image except `keep`, then dangling layers and
 * the build script's leftover stopped containers. Never throws: a docker error
 * is recorded and the sweep moves on, because a host must keep serving whether
 * or not it can reach the daemon.
 */
export async function runImageGc(
  opts: { keep: (string | null | undefined)[]; reason: string; root?: string },
  deps: ImageGcDeps = defaultDeps,
): Promise<ImageGcResult> {
  const root = opts.root ?? '/'
  const rootDiskBefore = deps.disk(root)
  const result: ImageGcResult = {
    reason: opts.reason,
    removed: [],
    failed: [],
    containersPruned: 0,
    freedBytes: 0,
    rootDiskBefore,
    rootDiskAfter: rootDiskBefore,
  }

  let rows: DockerImageRow[] = []
  try {
    rows = parseImageList(await deps.exec('docker', ['images', '--format', '{{json .}}']))
  } catch (err: any) {
    console.warn(`[image-gc] docker images failed (${opts.reason}): ${err?.message ?? err}`)
    result.rootDiskAfter = deps.disk(root)
    return result
  }

  const doomed = planImageGc(rows, opts.keep)
  for (const tag of doomed) {
    try {
      await deps.exec('docker', ['rmi', tag])
      result.removed.push(tag)
      metrics.inc(M.imageGcRemoved)
    } catch (err: any) {
      // A tag still referenced by a container, or already gone: not fatal.
      result.failed.push({ tag, error: String(err?.message ?? err).slice(0, 200) })
    }
  }

  try {
    await deps.exec('docker', ['image', 'prune', '-f'])
  } catch (err: any) {
    console.warn(`[image-gc] image prune failed: ${err?.message ?? err}`)
  }

  try {
    const out = await deps.exec('docker', ['container', 'prune', '-f', '--filter', `label=${CONTAINER_LABEL}`])
    const m = /Total reclaimed space:.*?(\d+)/.exec(out ?? '')
    result.containersPruned = m ? Number(m[1]) : 0
  } catch (err: any) {
    console.warn(`[image-gc] container prune failed: ${err?.message ?? err}`)
  }

  result.rootDiskAfter = deps.disk(root)
  result.freedBytes = Math.max(0, result.rootDiskAfter.freeBytes - result.rootDiskBefore.freeBytes)
  const mb = Math.round(result.freedBytes / 1024 / 1024)
  console.log(
    `[image-gc] ${opts.reason}: removed ${result.removed.length} image(s)` +
      (result.failed.length ? `, ${result.failed.length} failed` : '') +
      `, freed ${mb} MB; root disk ${result.rootDiskBefore.usedPct.toFixed(1)}% -> ${result.rootDiskAfter.usedPct.toFixed(1)}%`,
  )
  for (const f of result.failed) console.warn(`[image-gc] could not remove ${f.tag}: ${f.error}`)
  return result
}

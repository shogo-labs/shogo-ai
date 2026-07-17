// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Durable snapshot store for the microVM substrate.
 *
 * Local NVMe always holds the hot snapshot (vmstate + mem + per-VM rootfs) so a
 * same-host resume is sub-second (see FirecrackerVMManager.restoreVM). This
 * store is the DURABLE tier on top of that: it pushes those artifacts + a small
 * metadata blob off-box so a project survives a node-agent restart and can be
 * woken on a different host (cross-host mobility). Keyed per-project using the
 * same `{prefix}{projectId}/...` convention as packages/shared-runtime's
 * s3-sync, so a project's snapshots live beside its workspace archives.
 *
 * Staleness: a snapshot only restores against a byte-compatible rootfs. We stamp
 * the host's rootfs identity into the metadata; on pull, a mismatch means the
 * runtime image/deps changed under the project, so the snapshot is discarded and
 * the caller cold-boots instead of restoring a torn VM.
 *
 * Dependency-free by design (Bun's built-in S3 client) — the node-agent ships as
 * a single `bun run` with no `node_modules` to install during host bootstrap.
 */

import { statSync } from 'fs'
import { mkdir, copyFile, readFile, writeFile, rm, stat, open } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import type { MetalConfig } from './config'
import type { VmNet } from './net'

/** The three on-disk artifacts that make a restorable snapshot. */
export interface SnapshotFiles {
  vmstate: string
  mem: string
  rootfs: string
}

export interface SnapshotMeta {
  projectId: string
  net: VmNet
  vcpus: number
  memoryMB: number
  bytesMem: number
  bytesState: number
  createdAt: number
  /**
   * Absolute path of the per-VM rootfs at snapshot time. Firecracker bakes the
   * block-device backing-file path into the vmstate, so on restore the rootfs
   * MUST be materialized at exactly this path — a pull recreates it here.
   */
  rootfsPath: string
  /** Host rootfs identity at snapshot time; restore is only valid on a match. */
  rootfsIdentity: string
  /**
   * ETag of the durable source backup (`{projectId}/project-src.tar.gz`) that
   * was current when this snapshot was taken — the workspace frozen inside it
   * descends from that backup. Carried back into AssignedVm.backupParentEtag on
   * resume so a resumed VM's next suspend can safely overwrite exactly the
   * backup it derives from (and quarantine otherwise). Absent for a legacy
   * snapshot taken before lineage stamping shipped.
   */
  backupEtag?: string
  /** Store schema version, for forward-compat. */
  v: 1
  /**
   * Slim-mode fields (all optional; absent = legacy full/uncompressed snapshot):
   *   memCodec   — 'gzip' if the stored mem artifact is compressed.
   *   rootfsMode — 'diff' if the stored rootfs artifact is a CoW diff that must
   *                be reconstructed against the shared base; 'full' otherwise.
   *   baseIdentity — content-addressed key of the shared golden base the diff
   *                applies to (dm mode). The local path to materialize the diff
   *                on pull is `rootfsPath` (the dm CoW store path).
   */
  memCodec?: 'none' | 'gzip'
  rootfsMode?: 'full' | 'diff'
  /**
   * Codec of the stored rootfs artifact. In dm/diff slim mode the CoW store is a
   * large sparse file that is almost all zeros (only diverged 4 KiB chunks hold
   * data), so we gzip it: an ~8 GiB sparse diff collapses to the few MiB it
   * actually contains, which is the difference between a multi-GiB cold pull and
   * a fast one. 'none' = the artifact is stored raw.
   */
  rootfsCodec?: 'none' | 'gzip'
  baseIdentity?: string
  /**
   * Local path the pulled rootfs artifact must be materialized at. Differs from
   * `rootfsPath` only in dm/diff mode: rootfsPath is the mapper DEVICE baked
   * into the vmstate, while the diff artifact restores to the per-VM CoW store
   * file (from which the device is rebuilt before LoadSnapshot). Absent = write
   * to rootfsPath (full mode).
   */
  rootfsArtifactPath?: string
}

export interface PulledSnapshot {
  files: SnapshotFiles
  meta: SnapshotMeta
}

export interface SnapshotStore {
  readonly kind: 'none' | 'fs' | 's3'
  /** True if this store compresses mem + expects diff rootfs pushes (slim). */
  readonly slim: boolean
  /** Push artifacts + metadata for a project (overwrites any prior). */
  push(files: SnapshotFiles, meta: SnapshotMeta): Promise<void>
  /** Metadata only — cheap existence/staleness probe. null = absent. */
  head(projectId: string): Promise<SnapshotMeta | null>
  /**
   * Download artifacts into `destDir` and return their local paths + metadata.
   * null = absent OR stale (rootfsIdentity mismatch) → caller should cold-boot.
   */
  pull(projectId: string, destDir: string, rootfsIdentity: string): Promise<PulledSnapshot | null>
  remove(projectId: string): Promise<void>
  /** Upload the shared golden base once per identity (slim/diff mode). No-op otherwise. */
  ensureBase(identity: string, baseRootfsPath: string): Promise<void>
  /** Download the shared golden base to `destPath` (slim/diff restore). false = absent. */
  pullBase(identity: string, destPath: string): Promise<boolean>
}

/** Cheap, allocation-free rootfs identity: size + mtime of the golden image. */
export function computeRootfsIdentity(cfg: MetalConfig): string {
  if (cfg.rootfsIdentity) return cfg.rootfsIdentity
  try {
    const s = statSync(cfg.baseRootfs)
    return `sz${s.size}-mt${Math.round(s.mtimeMs)}`
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------

/** Local-only: durability disabled. Every op is a no-op / miss. */
class NoneStore implements SnapshotStore {
  readonly kind = 'none' as const
  readonly slim = false
  async push(): Promise<void> {}
  async head(): Promise<SnapshotMeta | null> {
    return null
  }
  async pull(): Promise<PulledSnapshot | null> {
    return null
  }
  async remove(): Promise<void> {}
  async ensureBase(): Promise<void> {}
  async pullBase(): Promise<boolean> {
    return false
  }
}

// --- streaming (de)compression helpers -------------------------------------

/** Stream a local file → gzip → a local dest path, no full buffering. */
async function writeGzip(srcPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  const gz = Bun.file(srcPath).stream().pipeThrough(new CompressionStream('gzip'))
  await Bun.write(destPath, new Response(gz))
}
/**
 * Inflate a local .gz file to a local dest path.
 *
 * Prefers `pigz` (parallel gzip) which inflates on all cores — the single
 * biggest component of an S3 hydration is decompressing the ~4 GiB mem image,
 * and single-threaded `gunzip` caps that at ~200 MiB/s (~19s). `pigz -dc` uses
 * the whole box (~2-3s on a 48-thread host). Falls back to `gunzip -c` where
 * pigz isn't installed (host-bootstrap installs it; older hosts still work).
 *
 * We do NOT use Bun's DecompressionStream here: piping a large (~300 MiB →
 * ~4 GiB) gzip through `Bun.write(dest, new Response(stream.pipeThrough(
 * DecompressionStream)))` silently aborts the process mid-inflate on the
 * bare-metal host (the .gz itself is valid — system `zcat` inflates it fully).
 * A spawned decompressor streams reliably with bounded memory.
 */
async function gunzipFile(srcGzPath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  const proc = Bun.spawn(
    ['sh', '-c', 'if command -v pigz >/dev/null 2>&1; then exec pigz -dc "$0" > "$1"; else exec gunzip -c "$0" > "$1"; fi', srcGzPath, destPath],
    { stdout: 'inherit', stderr: 'pipe' },
  )
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => '')
    throw new Error(`inflate ${srcGzPath} → ${destPath} failed (exit ${code}): ${err.slice(0, 200)}`)
  }
}

/**
 * Fetch bytes `[start, end)` of an object (end EXCLUSIVE, Blob.slice semantics).
 * The returned array MUST be exactly `end - start` bytes.
 */
export type RangeFetcher = (start: number, end: number) => Promise<Uint8Array>

/**
 * Download an object of known `size` into `dest` using parallel ranged GETs.
 *
 * Splits the object into `partBytes` chunks fetched up to `concurrency`-wide and
 * pwrites each chunk at its offset, so the wall-clock cost is bounded by the
 * link's aggregate throughput rather than a single stream. Kept storage-agnostic
 * (it takes a `RangeFetcher`, not an S3 client) so the offset math, coverage,
 * concurrency cap and reassembly are unit-testable without S3.
 */
export async function downloadRanged(
  dest: string,
  size: number,
  fetchRange: RangeFetcher,
  opts: { partBytes: number; concurrency: number },
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const partBytes = Math.max(1, Math.floor(opts.partBytes))
  const parts: Array<[number, number]> = []
  for (let start = 0; start < size; start += partBytes) {
    parts.push([start, Math.min(start + partBytes, size)])
  }
  const fh = await open(dest, 'w')
  try {
    // Preallocate so concurrent pwrites never race to extend the file.
    await fh.truncate(size)
    if (parts.length === 0) return // zero-byte object
    let nextPart = 0
    const worker = async (): Promise<void> => {
      for (let i = nextPart++; i < parts.length; i = nextPart++) {
        const [start, end] = parts[i]
        const buf = await fetchRange(start, end)
        if (buf.length !== end - start) {
          throw new Error(`ranged GET short read at [${start},${end}): got ${buf.length} bytes`)
        }
        await fh.write(buf, 0, buf.length, start)
      }
    }
    const lanes = Math.max(1, Math.min(opts.concurrency, parts.length))
    await Promise.all(Array.from({ length: lanes }, worker))
  } finally {
    await fh.close()
  }
}

/**
 * Filesystem-backed durable store. Copies artifacts to `dir/{prefix}{pid}/`.
 * In production this points at a separate durable mount; in the lifecycle e2e
 * it lives on a distinct path to prove the pull-on-miss / eviction round-trip.
 */
class FsStore implements SnapshotStore {
  readonly kind = 'fs' as const
  constructor(
    private root: string,
    private prefix: string,
    readonly slim: boolean,
    private basePrefix: string,
  ) {}

  private base(projectId: string): string {
    return join(this.root, this.prefix, projectId)
  }
  private baseArtifact(identity: string): string {
    return join(this.root, this.basePrefix, `${identity}.ext4`)
  }

  async push(files: SnapshotFiles, meta: SnapshotMeta): Promise<void> {
    // Never publish a torn snapshot: if a local artifact was evicted/deleted by
    // a concurrent GC/reclaim while this push was queued, abort BEFORE writing
    // meta.json so the durable store never gets a half-written (corrupt) set.
    await assertArtifacts(files)
    const dir = this.base(meta.projectId)
    await mkdir(dir, { recursive: true })
    const rootfsMode = meta.rootfsMode ?? 'full'
    // Slim + a CoW diff → gzip it (the sparse store is ~all zeros).
    const rootfsCodec: 'none' | 'gzip' = this.slim && rootfsMode === 'diff' ? 'gzip' : 'none'
    const rootfsName = (rootfsMode === 'diff' ? 'rootfs.diff' : 'rootfs.ext4') + (rootfsCodec === 'gzip' ? '.gz' : '')
    await copyFile(files.vmstate, join(dir, 'vmstate'))
    if (rootfsCodec === 'gzip') {
      await writeGzip(files.rootfs, join(dir, rootfsName))
    } else {
      await copyFile(files.rootfs, join(dir, rootfsName))
    }
    if (this.slim) {
      await writeGzip(files.mem, join(dir, 'mem.gz'))
    } else {
      await copyFile(files.mem, join(dir, 'mem'))
    }
    // Metadata written last so a reader never sees a torn set.
    const full: SnapshotMeta = { ...meta, memCodec: this.slim ? 'gzip' : 'none', rootfsMode, rootfsCodec }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(full))
  }

  async head(projectId: string): Promise<SnapshotMeta | null> {
    const metaPath = join(this.base(projectId), 'meta.json')
    if (!existsSync(metaPath)) return null
    try {
      return JSON.parse(await readFile(metaPath, 'utf8')) as SnapshotMeta
    } catch {
      return null
    }
  }

  async pull(projectId: string, destDir: string, rootfsIdentity: string): Promise<PulledSnapshot | null> {
    const meta = await this.head(projectId)
    if (!meta) return null
    if (meta.rootfsIdentity !== rootfsIdentity) return null // stale → cold boot
    const dir = this.base(projectId)
    await mkdir(destDir, { recursive: true })
    // vmstate/mem are passed to LoadSnapshot by path → any local path works.
    // rootfs artifact MUST land where the manager expects it (device-baked path
    // for full mode, per-VM CoW store for diff mode — see rootfsArtifactPath).
    const rootfsDest = meta.rootfsArtifactPath ?? meta.rootfsPath
    await mkdir(dirname(rootfsDest), { recursive: true })
    const files: SnapshotFiles = {
      vmstate: join(destDir, `${projectId}.vmstate`),
      mem: join(destDir, `${projectId}.mem`),
      rootfs: rootfsDest,
    }
    const baseName = meta.rootfsMode === 'diff' ? 'rootfs.diff' : 'rootfs.ext4'
    // Materialize the three artifacts concurrently (see S3Store.pull).
    await Promise.all([
      copyFile(join(dir, 'vmstate'), files.vmstate),
      meta.memCodec === 'gzip'
        ? gunzipFile(join(dir, 'mem.gz'), files.mem)
        : copyFile(join(dir, 'mem'), files.mem),
      meta.rootfsCodec === 'gzip'
        ? gunzipFile(join(dir, `${baseName}.gz`), files.rootfs)
        : copyFile(join(dir, baseName), files.rootfs),
    ])
    return { files, meta }
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.base(projectId), { recursive: true, force: true }).catch(() => {})
  }

  async ensureBase(identity: string, baseRootfsPath: string): Promise<void> {
    const dest = this.baseArtifact(identity)
    if (existsSync(dest)) return
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(baseRootfsPath, dest)
  }

  async pullBase(identity: string, destPath: string): Promise<boolean> {
    const src = this.baseArtifact(identity)
    if (!existsSync(src)) return false
    await mkdir(dirname(destPath), { recursive: true })
    await copyFile(src, destPath)
    return true
  }
}

/**
 * OCI Object Storage (S3-compatible) via Bun's built-in S3 client. Uses the
 * same S3_ENDPOINT / S3_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env
 * the runtime's s3-sync already consumes. Path-style + custom endpoint (OCI).
 */
class S3Store implements SnapshotStore {
  readonly kind = 's3' as const
  private client: import('bun').S3Client
  constructor(
    bucket: string,
    private prefix: string,
    private cfg: MetalConfig,
    readonly slim: boolean,
    private basePrefix: string,
  ) {
    // Imported lazily-typed; Bun provides S3Client at runtime.
    const { S3Client } = require('bun') as typeof import('bun')
    this.client = new S3Client({
      bucket,
      endpoint: cfg.s3Endpoint || undefined,
      region: cfg.s3Region,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    })
  }

  private key(projectId: string, name: string): string {
    return `${this.prefix}${projectId}/snapshot/${name}`
  }
  private baseKey(identity: string): string {
    return `${this.basePrefix}${identity}.ext4`
  }

  async push(files: SnapshotFiles, meta: SnapshotMeta): Promise<void> {
    // Never publish a torn snapshot (see FsStore.push). A missing/empty source
    // aborts the push before any object is written to S3.
    await assertArtifacts(files)
    const pid = meta.projectId
    const rootfsMode = meta.rootfsMode ?? 'full'
    // Slim + a CoW diff → gzip the sparse (mostly-zero) store so a cold pull
    // transfers the few MiB of real divergence, not the whole ~8 GiB device.
    const rootfsCodec: 'none' | 'gzip' = this.slim && rootfsMode === 'diff' ? 'gzip' : 'none'
    const rootfsName = (rootfsMode === 'diff' ? 'rootfs.diff' : 'rootfs.ext4') + (rootfsCodec === 'gzip' ? '.gz' : '')
    // Large artifacts stream from disk; Bun.file → S3Client.write handles it.
    if (this.slim) {
      await Bun.write(this.client.file(this.key(pid, 'mem.gz')), new Response(Bun.file(files.mem).stream().pipeThrough(new CompressionStream('gzip'))))
    } else {
      await this.client.write(this.key(pid, 'mem'), Bun.file(files.mem))
    }
    if (rootfsCodec === 'gzip') {
      await Bun.write(this.client.file(this.key(pid, rootfsName)), new Response(Bun.file(files.rootfs).stream().pipeThrough(new CompressionStream('gzip'))))
    } else {
      await this.client.write(this.key(pid, rootfsName), Bun.file(files.rootfs))
    }
    await this.client.write(this.key(pid, 'vmstate'), Bun.file(files.vmstate))
    // Metadata last: presence of meta.json = a complete, restorable set.
    const full: SnapshotMeta = { ...meta, memCodec: this.slim ? 'gzip' : 'none', rootfsMode, rootfsCodec }
    await this.client.write(this.key(pid, 'meta.json'), JSON.stringify(full))
  }

  async head(projectId: string): Promise<SnapshotMeta | null> {
    try {
      const txt = await this.client.file(this.key(projectId, 'meta.json')).text()
      return JSON.parse(txt) as SnapshotMeta
    } catch {
      return null
    }
  }

  async pull(projectId: string, destDir: string, rootfsIdentity: string): Promise<PulledSnapshot | null> {
    const meta = await this.head(projectId)
    if (!meta) return null
    if (meta.rootfsIdentity !== rootfsIdentity) return null
    await mkdir(destDir, { recursive: true })
    // rootfs artifact lands on the device-baked path (full) or the per-VM CoW
    // store (diff); see SnapshotMeta.rootfsArtifactPath.
    const rootfsDest = meta.rootfsArtifactPath ?? meta.rootfsPath
    const files: SnapshotFiles = {
      vmstate: join(destDir, `${projectId}.vmstate`),
      mem: join(destDir, `${projectId}.mem`),
      rootfs: rootfsDest,
    }
    const baseName = meta.rootfsMode === 'diff' ? 'rootfs.diff' : 'rootfs.ext4'
    // Hydrate the three artifacts CONCURRENTLY. They are independent objects and
    // the wake can't proceed until all are on disk, so serial downloads just
    // stack their latencies (vmstate + mem + rootfs). In parallel the wall-clock
    // cost collapses to the slowest single artifact (the mem image). Each
    // download/inflate is self-contained (distinct dest + tmp paths).
    await Promise.all([
      this.download(this.key(projectId, 'vmstate'), files.vmstate),
      meta.memCodec === 'gzip'
        ? this.downloadGunzip(this.key(projectId, 'mem.gz'), files.mem)
        : this.download(this.key(projectId, 'mem'), files.mem),
      meta.rootfsCodec === 'gzip'
        ? this.downloadGunzip(this.key(projectId, `${baseName}.gz`), files.rootfs)
        : this.download(this.key(projectId, baseName), files.rootfs),
    ])
    return { files, meta }
  }

  private async download(key: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true })
    const partBytes = this.cfg.s3GetPartBytes
    const concurrency = this.cfg.s3GetConcurrency
    // Large objects: parallel ranged GET to saturate the link. Small objects
    // (vmstate, or anything <= one part) go single-stream — the overhead of a
    // stat + range split isn't worth it.
    if (concurrency > 1 && partBytes > 0) {
      let size = 0
      try {
        size = (await this.client.file(key).stat()).size
      } catch {
        size = 0
      }
      if (size > partBytes) {
        await downloadRanged(
          dest,
          size,
          async (start, end) => new Uint8Array(await this.client.file(key).slice(start, end).arrayBuffer()),
          { partBytes, concurrency },
        )
        return
      }
    }
    // S3 → disk via the client's file handle (Bun buffers/streams internally).
    await Bun.write(dest, this.client.file(key))
  }

  /**
   * Download a gzipped artifact then inflate it. We deliberately land the .gz on
   * disk first and gunzip from the LOCAL file rather than piping the S3
   * ReadableStream straight through a DecompressionStream: against OCI's
   * S3-compat endpoint that direct pipe stalls, whereas the buffered download +
   * local inflate is reliable (and the .gz is small — slim mode compresses the
   * 2 GiB mem to ~300 MiB and the sparse CoW diff to a few MiB).
   */
  private async downloadGunzip(key: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}.gz.tmp`
    // Fetch the compressed blob via the (ranged) download path — this is the
    // ~400 MiB mem.gz that dominates hydration — then inflate.
    await this.download(key, tmp)
    await gunzipFile(tmp, dest)
    await rm(tmp, { force: true }).catch(() => {})
  }

  async remove(projectId: string): Promise<void> {
    // Delete every possible snapshot artifact IN PARALLEL. Seven sequential OCI
    // round-trips (~1-2s each under load) can stretch a /destroy past the agent
    // HTTP server's connection idle window, so the caller's request is dropped
    // (empty reply) even though the teardown itself succeeds and the agent keeps
    // heartbeating. Fanning out keeps the whole delete to ~one round-trip, and a
    // per-object timeout means one stuck object can't stall the rest.
    const names = ['meta.json', 'vmstate', 'mem', 'mem.gz', 'rootfs.ext4', 'rootfs.diff', 'rootfs.diff.gz']
    await Promise.all(
      names.map((name) => {
        const del = this.client.delete(this.key(projectId, name)).catch(() => {})
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000))
        return Promise.race([del, timeout])
      }),
    )
  }

  async ensureBase(identity: string, baseRootfsPath: string): Promise<void> {
    const key = this.baseKey(identity)
    try {
      // Skip if already uploaded (content-addressed by identity).
      if ((await this.client.file(key).stat()).size > 0) return
    } catch {
      /* absent → upload */
    }
    await this.client.write(key, Bun.file(baseRootfsPath))
  }

  async pullBase(identity: string, destPath: string): Promise<boolean> {
    const key = this.baseKey(identity)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await Bun.write(destPath, this.client.file(key))
      return true
    } catch {
      return false
    }
  }
}

export function createSnapshotStore(cfg: MetalConfig): SnapshotStore {
  switch (cfg.snapStore) {
    case 'fs':
      return new FsStore(cfg.snapStoreDir, cfg.snapStorePrefix, cfg.snapSlim, cfg.snapBasePrefix)
    case 's3':
      if (!cfg.snapStoreBucket) {
        console.warn('[snapshot-store] METAL_SNAP_STORE=s3 but no bucket configured — falling back to none')
        return new NoneStore()
      }
      return new S3Store(cfg.snapStoreBucket, cfg.snapStorePrefix, cfg, cfg.snapSlim, cfg.snapBasePrefix)
    default:
      return new NoneStore()
  }
}

/** Await a file to exist + be non-empty (used to sanity-check pulled artifacts). */
export async function assertArtifacts(files: SnapshotFiles): Promise<void> {
  for (const [k, p] of Object.entries(files)) {
    const s = await stat(p).catch(() => null)
    if (!s || s.size === 0) throw new Error(`snapshot artifact ${k} missing/empty: ${p}`)
  }
}

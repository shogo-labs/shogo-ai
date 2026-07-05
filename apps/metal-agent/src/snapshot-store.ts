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
import { mkdir, copyFile, readFile, writeFile, rm, stat } from 'fs/promises'
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
  /** Store schema version, for forward-compat. */
  v: 1
}

export interface PulledSnapshot {
  files: SnapshotFiles
  meta: SnapshotMeta
}

export interface SnapshotStore {
  readonly kind: 'none' | 'fs' | 's3'
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
  async push(): Promise<void> {}
  async head(): Promise<SnapshotMeta | null> {
    return null
  }
  async pull(): Promise<PulledSnapshot | null> {
    return null
  }
  async remove(): Promise<void> {}
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
  ) {}

  private base(projectId: string): string {
    return join(this.root, this.prefix, projectId)
  }

  async push(files: SnapshotFiles, meta: SnapshotMeta): Promise<void> {
    const base = this.base(meta.projectId)
    await mkdir(base, { recursive: true })
    await Promise.all([
      copyFile(files.vmstate, join(base, 'vmstate')),
      copyFile(files.mem, join(base, 'mem')),
      copyFile(files.rootfs, join(base, 'rootfs.ext4')),
    ])
    // Metadata written last so a reader never sees a torn set.
    await writeFile(join(base, 'meta.json'), JSON.stringify(meta))
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
    const base = this.base(projectId)
    await mkdir(destDir, { recursive: true })
    // vmstate/mem are passed to LoadSnapshot by path → any local path works.
    // rootfs MUST land on the path baked into the vmstate (see SnapshotMeta).
    await mkdir(dirname(meta.rootfsPath), { recursive: true })
    const files: SnapshotFiles = {
      vmstate: join(destDir, `${projectId}.vmstate`),
      mem: join(destDir, `${projectId}.mem`),
      rootfs: meta.rootfsPath,
    }
    await Promise.all([
      copyFile(join(base, 'vmstate'), files.vmstate),
      copyFile(join(base, 'mem'), files.mem),
      copyFile(join(base, 'rootfs.ext4'), files.rootfs),
    ])
    return { files, meta }
  }

  async remove(projectId: string): Promise<void> {
    await rm(this.base(projectId), { recursive: true, force: true }).catch(() => {})
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
    cfg: MetalConfig,
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

  async push(files: SnapshotFiles, meta: SnapshotMeta): Promise<void> {
    const pid = meta.projectId
    // Large artifacts stream from disk; Bun.file → S3Client.write handles it.
    await this.client.write(this.key(pid, 'mem'), Bun.file(files.mem))
    await this.client.write(this.key(pid, 'rootfs.ext4'), Bun.file(files.rootfs))
    await this.client.write(this.key(pid, 'vmstate'), Bun.file(files.vmstate))
    // Metadata last: presence of meta.json = a complete, restorable set.
    await this.client.write(this.key(pid, 'meta.json'), JSON.stringify(meta))
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
    // rootfs MUST land on the vmstate-baked path (see SnapshotMeta.rootfsPath).
    const files: SnapshotFiles = {
      vmstate: join(destDir, `${projectId}.vmstate`),
      mem: join(destDir, `${projectId}.mem`),
      rootfs: meta.rootfsPath,
    }
    await this.download(this.key(projectId, 'vmstate'), files.vmstate)
    await this.download(this.key(projectId, 'mem'), files.mem)
    await this.download(this.key(projectId, 'rootfs.ext4'), files.rootfs)
    return { files, meta }
  }

  private async download(key: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true })
    // Stream S3 → disk (mem/rootfs are multi-GB; never buffer them whole).
    await Bun.write(dest, this.client.file(key))
  }

  async remove(projectId: string): Promise<void> {
    for (const name of ['meta.json', 'vmstate', 'mem', 'rootfs.ext4']) {
      await this.client.delete(this.key(projectId, name)).catch(() => {})
    }
  }
}

export function createSnapshotStore(cfg: MetalConfig): SnapshotStore {
  switch (cfg.snapStore) {
    case 'fs':
      return new FsStore(cfg.snapStoreDir, cfg.snapStorePrefix)
    case 's3':
      if (!cfg.snapStoreBucket) {
        console.warn('[snapshot-store] METAL_SNAP_STORE=s3 but no bucket configured — falling back to none')
        return new NoneStore()
      }
      return new S3Store(cfg.snapStoreBucket, cfg.snapStorePrefix, cfg)
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

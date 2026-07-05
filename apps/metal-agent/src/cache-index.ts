// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Persistent local cache index.
 *
 * The `suspended` map that tracks which projects have a hot snapshot on this
 * host lives in memory. Without persistence, a node-agent restart (every deploy)
 * loses it — and the orphan reaper would then delete thousands of perfectly good
 * snapshots on NVMe, forcing every project through a durable-store pull. That is
 * a self-inflicted stampede on every deploy.
 *
 * So on every suspend we write a small JSON index entry beside the hot files;
 * at startup we rehydrate the `suspended` map from these entries (dropping any
 * whose artifacts are missing). The index is also the authority the orphan
 * reaper checks before deleting a file, and it carries `lastAccessAt` so LRU
 * survives restarts too.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VmNet } from './net'

export interface CacheEntry {
  projectId: string
  vmId: string
  snapshotPath: string
  memFilePath: string
  rootfs: string
  net: VmNet
  vcpus: number
  memoryMB: number
  bytesMem: number
  bytesState: number
  /** Actual allocated NVMe bytes of the rootfs (CoW-aware), measured at suspend. */
  bytesRootfs: number
  createdAt: number
  suspendedAt: number
  lastAccessAt: number
  rootfsIdentity: string
  v: 1
}

export class CacheIndex {
  private dir: string

  constructor(snapDir: string) {
    this.dir = join(snapDir, 'index')
    mkdirSync(this.dir, { recursive: true })
  }

  private path(projectId: string): string {
    return join(this.dir, `${encodeURIComponent(projectId)}.json`)
  }

  put(entry: CacheEntry): void {
    // atomic-ish: write tmp then rename so a reader never sees a torn file.
    const p = this.path(entry.projectId)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(entry))
    try {
      renameSync(tmp, p) // atomic on the same filesystem
    } catch {
      writeFileSync(p, JSON.stringify(entry))
      rmSync(tmp, { force: true })
    }
  }

  get(projectId: string): CacheEntry | null {
    const p = this.path(projectId)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as CacheEntry
    } catch {
      return null
    }
  }

  touch(projectId: string, at = Date.now()): void {
    const e = this.get(projectId)
    if (e) {
      e.lastAccessAt = at
      this.put(e)
    }
  }

  remove(projectId: string): void {
    rmSync(this.path(projectId), { force: true })
  }

  /** All valid entries; silently skips corrupt files. */
  all(): CacheEntry[] {
    const out: CacheEntry[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      try {
        const e = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as CacheEntry
        if (e && e.projectId) out.push(e)
      } catch {
        /* skip corrupt */
      }
    }
    return out
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-VM second data drive — the docker-class VM's persistent /var/lib/docker
 * volume (Phase 1 of the Tier 2 docker project class plan).
 *
 * Deliberately much simpler than rootfs.ts's CoW machinery: this drive has no
 * shared golden base to snapshot against (every project's Docker layer/volume
 * data is unique from the moment dockerd first writes to it), so there is
 * nothing to deduplicate. It is just a sparse per-VM ext4 file, pre-formatted
 * on the host so the guest only has to `mount`, not `mkfs` — a formatted-but-
 * empty ext4 is cheap to create and the guest's fc-init addendum
 * (packages/agent-runtime/Dockerfile.docker) mounts it at /var/lib/docker
 * before starting dockerd.
 *
 * Durability tier today: LOCAL DISK ONLY, matching the same tier the rootfs
 * itself has under the default `METAL_SNAP_STORE=none` — the file persists
 * across suspend/resume on the SAME host (suspend never calls release()) but
 * is not pushed to the durable S3 store, so a project evicted from local NVMe
 * or resumed on a different host loses its Docker volume data and cold-boots
 * with a fresh, empty drive. Cross-host/durable persistence for this drive is
 * explicitly tracked as a follow-up ("Phase 1: per-project data volume
 * durability + GC treatment") and is NOT implemented here.
 */

import { closeSync, existsSync, ftruncateSync, openSync, rmSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import type { MetalConfig } from './config'
import { allocatedBytes } from './disk'

export class DataDriveProvisioner {
  constructor(private cfg: MetalConfig) {}

  private path(vmId: string): string {
    return join(this.cfg.runDir, `${vmId}.data.ext4`)
  }

  /**
   * Create a fresh, formatted, empty data drive for a new VM. Sparse — logical
   * size is `sizeMiB`, but only blocks the guest actually writes consume NVMe.
   */
  provision(vmId: string, sizeMiB: number): string {
    const dst = this.path(vmId)
    const fd = openSync(dst, 'w')
    try {
      ftruncateSync(fd, sizeMiB * 1024 * 1024)
    } finally {
      closeSync(fd)
    }
    this.runMkfs(dst)
    return dst
  }

  /** Overridable seam for tests — the real host always has mkfs.ext4. */
  protected runMkfs(path: string): void {
    // -q quiet, -F force (operating on a plain file, not a block device).
    execFileSync('mkfs.ext4', ['-q', '-F', path])
  }

  /** True if a data-drive backing file exists at this path (restore check). */
  exists(dataDrivePath: string): boolean {
    return existsSync(dataDrivePath)
  }

  /** Allocated (not logical) NVMe bytes — for cache/disk accounting. */
  allocatedBytes(dataDrivePath: string): number {
    try {
      return allocatedBytes(dataDrivePath)
    } catch {
      return 0
    }
  }

  /** Tear down a VM's data drive (destroy / evict — never called on suspend). */
  release(dataDrivePath: string): void {
    rmSync(dataDrivePath, { force: true })
  }

  /** Logical size (MiB) of an existing data drive file, for diagnostics. */
  sizeMiB(dataDrivePath: string): number {
    try {
      return Math.round(statSync(dataDrivePath).size / (1024 * 1024))
    } catch {
      return 0
    }
  }
}

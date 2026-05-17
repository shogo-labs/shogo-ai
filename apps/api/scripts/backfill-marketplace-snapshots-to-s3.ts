// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * One-shot backfiller: walk every `MarketplaceListingVersion` row
 * with `workspaceSnapshot != null && workspaceSnapshotKey == null`,
 * materialize the JSON snapshot to a tmp dir, tar + upload to S3,
 * and persist the resulting key/bytes/checksum back onto the row.
 *
 * Idempotent: each pass only picks up rows that don't yet have an S3
 * key. Safe to invoke multiple times — at boot, from a CLI, or as
 * part of a deploy hook.
 *
 * Local/desktop mode skip: the marketplace is cloud-only in local
 * mode, so we short-circuit before touching the DB.
 *
 * The script runs every published version through the same code path
 * `POST /creator/listings/:id/versions` uses going forward, which
 * keeps the field semantics consistent: `workspaceSnapshotBytes` is
 * the *compressed* tar.gz size, not the JSON byte count.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { prisma } from '../src/lib/prisma'
import { uploadProjectSnapshot } from '../src/services/marketplace-snapshot-storage.service'

const PROJECT_ROOT = resolve(import.meta.dir, '../../..')

function getWorkspacesDir(): string {
  return process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
}

interface SnapshotFileMap {
  [path: string]: string | { data: string; encoding?: string }
}

function extractFileMap(snapshot: unknown): SnapshotFileMap | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const root = snapshot as Record<string, unknown>
  const fileMap =
    root.files != null && typeof root.files === 'object' && !Array.isArray(root.files)
      ? (root.files as Record<string, unknown>)
      : (root as Record<string, unknown>)
  return fileMap as SnapshotFileMap
}

/**
 * Materialize a workspaceSnapshot JSON blob into a fresh staging
 * project under `WORKSPACES_DIR`, then call `uploadProjectSnapshot`
 * to tar+upload it. The staging dir is cleaned up after upload.
 *
 * We deliberately reuse the same workspaces dir layout so
 * `uploadProjectSnapshot` works unmodified — its public API takes a
 * `projectId` and looks up the dir itself.
 */
async function materializeAndUpload(
  versionId: string,
  listingId: string,
  version: string,
  snapshot: unknown,
): Promise<{ key: string; bytes: number; checksum: string } | null> {
  const fileMap = extractFileMap(snapshot)
  if (!fileMap) return null

  const stagingId = `__snapshot_backfill_${versionId}`
  const stagingDir = join(getWorkspacesDir(), stagingId)
  mkdirSync(stagingDir, { recursive: true })
  try {
    for (const [relPath, val] of Object.entries(fileMap)) {
      if (!relPath || relPath.startsWith('/') || relPath.includes('..')) continue
      let body: Buffer
      if (typeof val === 'string') {
        body = Buffer.from(val, 'utf8')
      } else if (val && typeof val === 'object' && typeof val.data === 'string') {
        const enc = val.encoding === 'base64' ? 'base64' : 'utf8'
        body = Buffer.from(val.data, enc)
      } else {
        continue
      }
      const abs = join(stagingDir, relPath)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, body)
    }
    return await uploadProjectSnapshot(stagingId, listingId, version)
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

export interface BackfillStats {
  inspected: number
  migrated: number
  failed: number
  skippedNoSnapshot: number
}

export async function runSnapshotBackfill(
  opts: { quiet?: boolean } = {},
): Promise<BackfillStats> {
  const { quiet = false } = opts
  const log = (msg: string) => {
    if (!quiet) console.log(`[snapshot-backfill] ${msg}`)
  }
  if (process.env.SHOGO_LOCAL_MODE === 'true') {
    log('local mode — skipping')
    return { inspected: 0, migrated: 0, failed: 0, skippedNoSnapshot: 0 }
  }
  if (!process.env.S3_WORKSPACES_BUCKET) {
    log('S3_WORKSPACES_BUCKET not set — skipping (configure to enable backfill)')
    return { inspected: 0, migrated: 0, failed: 0, skippedNoSnapshot: 0 }
  }

  const stats: BackfillStats = {
    inspected: 0,
    migrated: 0,
    failed: 0,
    skippedNoSnapshot: 0,
  }

  // Stream through versions in batches so we don't load every
  // workspace snapshot into memory at once. 50 rows per page is a
  // safe ceiling: even at 5MB JSON each that's ~250MB peak.
  const PAGE = 50
  let cursor: string | null = null
  while (true) {
    const rows: Array<{
      id: string
      listingId: string
      version: string
      workspaceSnapshot: unknown
    }> = await prisma.marketplaceListingVersion.findMany({
      where: { workspaceSnapshotKey: null, workspaceSnapshot: { not: null } } as any,
      select: { id: true, listingId: true, version: true, workspaceSnapshot: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (rows.length === 0) break

    for (const row of rows) {
      stats.inspected++
      try {
        const result = await materializeAndUpload(
          row.id,
          row.listingId,
          row.version,
          row.workspaceSnapshot,
        )
        if (!result) {
          stats.skippedNoSnapshot++
          continue
        }
        await prisma.marketplaceListingVersion.update({
          where: { id: row.id },
          data: {
            workspaceSnapshotKey: result.key,
            workspaceSnapshotBytes: result.bytes,
            workspaceSnapshotChecksum: result.checksum,
          },
        })
        stats.migrated++
        log(
          `migrated version ${row.id} (listing=${row.listingId}, version=${row.version}) ` +
            `→ ${result.key} (${result.bytes} bytes)`,
        )
      } catch (err) {
        stats.failed++
        console.error(`[snapshot-backfill] failed for version ${row.id}:`, err)
      }
    }

    cursor = rows[rows.length - 1].id
    if (rows.length < PAGE) break
  }

  log(
    `inspected=${stats.inspected} migrated=${stats.migrated} ` +
      `failed=${stats.failed} skippedNoSnapshot=${stats.skippedNoSnapshot}`,
  )
  return stats
}

if (import.meta.main) {
  runSnapshotBackfill()
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[snapshot-backfill] fatal:', err)
      await prisma.$disconnect().catch(() => undefined)
      process.exit(1)
    })
}

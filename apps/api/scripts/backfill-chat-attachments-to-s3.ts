// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Rewrites historical chat attachment data URLs to references in object
 * storage. The script is idempotent: rows with no inline file/image payloads
 * are ignored on subsequent runs.
 *
 * Run against one writer only:
 *   bun apps/api/scripts/backfill-chat-attachments-to-s3.ts --dry-run
 *   bun apps/api/scripts/backfill-chat-attachments-to-s3.ts
 */

import { prisma } from '../src/lib/prisma'
import {
  externalizeMessageAttachments,
  externalizeToolOutput,
} from '../src/lib/chat-attachments'

const PAGE_SIZE = 25
const DELAY_MS = Number(process.env.CHAT_ATTACHMENT_BACKFILL_DELAY_MS || 250)
const dryRun = process.argv.includes('--dry-run')

export interface ChatAttachmentBackfillStats {
  inspected: number
  migrated: number
  failed: number
  uploaded: number
  bytes: number
}

export interface ChatAttachmentBackfillDeps {
  prisma: typeof prisma
  externalizeMessageAttachments: typeof externalizeMessageAttachments
  externalizeToolOutput: typeof externalizeToolOutput
}

function containsInlineAttachment(value: unknown): boolean {
  return typeof value === 'string' && (
    value.includes('data:') ||
    value.includes('"data"') ||
    value.includes('"imageData"')
  )
}

function parseParts(value: unknown): any[] | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export async function runChatAttachmentBackfill(
  options: {
    dryRun?: boolean
    quiet?: boolean
    deps?: Partial<ChatAttachmentBackfillDeps>
  } = {},
): Promise<ChatAttachmentBackfillStats> {
  const isDryRun = options.dryRun ?? dryRun
  const quiet = options.quiet ?? false
  const db = options.deps?.prisma ?? prisma
  const externalizeFiles =
    options.deps?.externalizeMessageAttachments ?? externalizeMessageAttachments
  const externalizeTools = options.deps?.externalizeToolOutput ?? externalizeToolOutput
  const log = (message: string) => {
    if (!quiet) console.log(`[chat-attachment-backfill] ${message}`)
  }

  if (!process.env.S3_ARTIFACT_BUCKET && !process.env.S3_WORKSPACES_BUCKET) {
    log('no object-storage bucket configured — refusing to run')
    return { inspected: 0, migrated: 0, failed: 0, uploaded: 0, bytes: 0 }
  }

  const stats: ChatAttachmentBackfillStats = {
    inspected: 0,
    migrated: 0,
    failed: 0,
    uploaded: 0,
    bytes: 0,
  }
  let cursor: string | undefined

  while (true) {
    // Page by `id > cursor` rather than a Prisma cursor: a migrated cursor row
    // no longer matches the filter, and `skip: 1` would drop the next row.
    const rows = await db.chatMessage.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { imageData: { not: null } },
          { parts: { contains: 'data:' } },
          { parts: { contains: '"type":"image"' } },
        ],
      },
      select: { id: true, sessionId: true, parts: true, imageData: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    })
    if (rows.length === 0) break

    for (const row of rows) {
      stats.inspected++
      try {
        const fileResult = await externalizeFiles(
          row.sessionId,
          row.parts,
          row.imageData,
          { dryRun: isDryRun },
        )
        let rewrittenParts = fileResult.parts
        let toolChanged = false

        const parsedParts = parseParts(rewrittenParts)
        if (parsedParts && parsedParts.some((part) => containsInlineAttachment(JSON.stringify(part)))) {
          const toolParts = await externalizeTools(row.sessionId, parsedParts, { dryRun: isDryRun })
          rewrittenParts = JSON.stringify(toolParts)
          toolChanged = rewrittenParts !== JSON.stringify(parsedParts)
        }

        const changed = fileResult.changed || toolChanged
        stats.uploaded += fileResult.uploaded
        stats.bytes += fileResult.bytes
        stats.failed += fileResult.failed

        if (changed) {
          if (!isDryRun) {
            await db.chatMessage.update({
              where: { id: row.id },
              data: {
                parts: rewrittenParts,
                imageData: fileResult.imageData,
              },
            })
          }
          stats.migrated++
        }

        if (!quiet && (changed || fileResult.failed > 0)) {
          log(`${isDryRun ? 'would migrate' : 'migrated'} ${row.id} ` +
            `(uploads=${fileResult.uploaded}, bytes=${fileResult.bytes}, failures=${fileResult.failed})`)
        }
      } catch (error: any) {
        stats.failed++
        console.error(`[chat-attachment-backfill] failed for ${row.id}:`, error?.message || error)
      }
    }

    cursor = rows[rows.length - 1]!.id
    await sleep(DELAY_MS)
    if (rows.length < PAGE_SIZE) break
  }

  log(
    `${isDryRun ? 'would migrate' : 'migrated'}=${stats.migrated} ` +
    `inspected=${stats.inspected} uploaded=${stats.uploaded} bytes=${stats.bytes} failures=${stats.failed}`,
  )
  return stats
}

if (import.meta.main) {
  runChatAttachmentBackfill()
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error('[chat-attachment-backfill] fatal:', error)
      await prisma.$disconnect().catch(() => undefined)
      process.exit(1)
    })
}

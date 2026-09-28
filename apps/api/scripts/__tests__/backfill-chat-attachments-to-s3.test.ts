// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const rows = [{
  id: 'message-1',
  sessionId: 'session-1',
  parts: JSON.stringify([{
    type: 'file',
    mediaType: 'image/png',
    url: 'data:image/png;base64,aGk=',
  }]),
  imageData: 'data:image/png;base64,aGk=',
}]

const findMany = mock(async () => {
  const result = rows.length > 0 ? [rows[0]] : []
  rows.splice(0, rows.length)
  return result
})
const update = mock(async () => ({}))

const externalizeMessageAttachments = mock(async () => ({
  parts: JSON.stringify([{
    type: 'file',
    mediaType: 'image/png',
    url: '/api/chat-attachments/artifacts/chat-attachments/session-1/hash.png',
    attachmentKey: 'artifacts/chat-attachments/session-1/hash.png',
  }]),
  imageData: null,
  changed: true,
  uploaded: 1,
  bytes: 2,
  failed: 0,
}))
const externalizeToolOutput = mock(async (_sessionId: string, parts: any[]) => parts)

process.env.S3_ARTIFACT_BUCKET = 'test-bucket'

const { runChatAttachmentBackfill } = await import('../backfill-chat-attachments-to-s3')

beforeEach(() => {
  rows.push({
    id: 'message-1',
    sessionId: 'session-1',
    parts: JSON.stringify([{
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,aGk=',
    }]),
    imageData: 'data:image/png;base64,aGk=',
  })
  findMany.mockClear()
  update.mockClear()
  externalizeMessageAttachments.mockClear()
})

describe('chat attachment backfill', () => {
  test('dry-run inspects and reports rows without updating the database', async () => {
    const stats = await runChatAttachmentBackfill({
      dryRun: true,
      quiet: true,
      deps: {
        prisma: {
          chatMessage: { findMany, update },
        } as any,
        externalizeMessageAttachments: externalizeMessageAttachments as any,
        externalizeToolOutput: externalizeToolOutput as any,
      },
    })
    expect(stats.migrated).toBe(1)
    expect(stats.uploaded).toBe(1)
    expect(stats.bytes).toBe(2)
    expect(update).not.toHaveBeenCalled()
  })

  test('migrates every row across pages even as migrated rows leave the filter', async () => {
    const table = Array.from({ length: 60 }, (_, index) => ({
      id: `message-${String(index).padStart(3, '0')}`,
      sessionId: 'session-1',
      parts: JSON.stringify([{ type: 'file', url: 'data:image/png;base64,aGk=' }]),
      imageData: null as string | null,
    }))
    const pagedFindMany = mock(async (args: any) => {
      // Mirrors Prisma: `cursor` is `id >= cursor` applied with the filter,
      // then `skip` drops leading results.
      const after = args.where.id?.gt
      const from = args.cursor?.id
      return table
        .filter((row) => row.parts.includes('data:'))
        .filter((row) => !after || row.id > after)
        .filter((row) => !from || row.id >= from)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(args.skip ?? 0)
        .slice(0, args.take)
    })
    const pagedUpdate = mock(async ({ where, data }: any) => {
      const row = table.find((candidate) => candidate.id === where.id)!
      row.parts = data.parts
      return row
    })
    const migrate = mock(async () => ({
      parts: JSON.stringify([{ type: 'file', url: '/api/chat-attachments/artifacts/chat-attachments/session-1/hash.png' }]),
      imageData: null,
      changed: true,
      uploaded: 1,
      bytes: 2,
      failed: 0,
    }))

    const stats = await runChatAttachmentBackfill({
      dryRun: false,
      quiet: true,
      deps: {
        prisma: { chatMessage: { findMany: pagedFindMany, update: pagedUpdate } } as any,
        externalizeMessageAttachments: migrate as any,
        externalizeToolOutput: externalizeToolOutput as any,
      },
    })
    expect(stats.migrated).toBe(60)
    expect(table.every((row) => !row.parts.includes('data:'))).toBe(true)
  })
})

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-213 acceptance — the client contract, end to end.
 *
 * The point of the card is a number: the `/chat` request body must not grow
 * with the attachment. So this drives the real composer helper
 * (`prepareOutgoingFiles`) against a real HTTP server standing in for the
 * runtime's `PUT /agent/chat/attachments`, then builds the request the real
 * transport builds (`trimLegacyInlineAttachments`, as `useChatTransport` wires
 * it) and measures it.
 *
 * Acceptance criteria covered here: 1 (client half — body < 64 KB, size
 * independent of the file), 2 (no base64 in the persisted parts), 3 (later
 * turns resend no bytes), 7 (over the cap: message surfaces, nothing sent),
 * 10 (native uploads from the uri, no base64).
 */
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trimLegacyInlineAttachments } from '@shogo/shared-app/chat'

mock.module('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  readAsStringAsync: async () => {
    throw new Error('the web path must not read bytes back')
  },
  createUploadTask: () => ({
    uploadAsync: async () => ({ status: 200, body: JSON.stringify({ savedPath: 'native.zip' }) }),
  }),
}))

const { prepareOutgoingFiles, MAX_INLINE_FALLBACK_BYTES } = await import('../chat-attachment-upload')

const CHAT_BODY_LIMIT = 64 * 1024

interface Received {
  name: string
  mediaType: string
  bytes: number
}

/**
 * Stands in for the runtime's `PUT /agent/chat/attachments`.
 *
 * It is a fetch stub rather than a real `Bun.serve` because apps/mobile's test
 * preload installs a DOM (happy-dom) that replaces `fetch`/`Response`, so a
 * real socket would be parsed by that shim. The route's own behaviour over a
 * real socket is covered by
 * `packages/agent-runtime/src/__tests__/qa-sho213-chat-attachment-upload.acceptance.test.ts`;
 * what this file needs from it is only the contract.
 */
const received: Received[] = []
/** Set to force the upload route to refuse the next upload. */
let refuseWith: { status: number; code: string; message: string } | null = null
const agentUrl = 'https://api.example.com/api/workspaces/ws-1/agent-proxy'

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const uploadFetch = (async (input: any, init: any) => {
  const url = new URL(String(input))
  const name = url.searchParams.get('name') ?? 'upload'
  if (refuseWith) {
    return jsonResponse(refuseWith.status, {
      error: { code: refuseWith.code, message: refuseWith.message },
    })
  }
  const mediaType = (init?.headers?.['content-type'] as string) ?? 'application/octet-stream'
  const body = init?.body as { size?: number } | undefined
  const bytes = typeof body?.size === 'number' ? body.size : 0
  received.push({ name, mediaType, bytes })
  const savedPath = name.endsWith('.zip') ? name : `files/${name}`
  return jsonResponse(200, { savedPath, name, mediaType, bytes, summary: `- \`${savedPath}\`` })
}) as unknown as typeof fetch

function pseudoRandomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = 17
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = x & 0xff
  }
  return out
}

/** The body `useChatTransport.prepareSendMessagesRequest` puts on the wire. */
function chatRequestBody(messages: unknown[], extraBody: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extraBody,
    id: 'chat-1',
    messages: trimLegacyInlineAttachments(messages as any),
    trigger: 'submit-message',
    messageId: 'msg-2',
  })
}

describe('AC1/AC2 — a large archive never rides in the chat body', () => {
  test('an 8 MB and a 32 MB zip produce chat bodies the same size', async () => {
    const bodies: number[] = []
    for (const mb of [8, 32]) {
      const bytes = pseudoRandomBytes(mb * 1024 * 1024)
      const parts = await prepareOutgoingFiles(
        [
          {
            name: `bundle-${mb}.zip`,
            type: 'application/zip',
            size: bytes.length,
            file: new File([bytes], `bundle-${mb}.zip`, { type: 'application/zip' }),
          },
        ],
        { agentUrl, fetchImpl: uploadFetch },
      )

      // AC2: the part the client persists carries a reference, never bytes.
      expect(parts.length).toBe(1)
      expect(parts[0].savedPath).toBe(`bundle-${mb}.zip`)
      expect(parts[0].url.startsWith('data:')).toBe(false)
      expect(JSON.stringify(parts)).not.toContain(';base64,')

      const body = chatRequestBody([
        { role: 'user', parts: [{ type: 'text', text: `here is the archive (${mb} MB)` }, ...parts] },
      ])
      expect(body.length).toBeLessThan(CHAT_BODY_LIMIT)
      expect(body).not.toContain(';base64,')
      bodies.push(body.length)
    }

    // The whole point: body size is independent of attachment size.
    expect(Math.abs(bodies[1] - bodies[0])).toBeLessThan(1024)
    // And the runtime really received the bytes.
    expect(received.map((r) => r.bytes)).toEqual([8 * 1024 * 1024, 32 * 1024 * 1024])
  }, 60_000)

  test('a 10 MB CSV is uploaded, not inlined', async () => {
    const csv = new TextEncoder().encode('id,name\n1,acme\n'.repeat(700_000))
    const parts = await prepareOutgoingFiles(
      [
        {
          name: 'ledger.csv',
          type: 'text/csv',
          size: csv.length,
          file: new File([csv], 'ledger.csv', { type: 'text/csv' }),
        },
      ],
      { agentUrl, fetchImpl: uploadFetch },
    )

    expect(parts[0].savedPath).toBe('files/ledger.csv')
    expect(chatRequestBody([{ role: 'user', parts }]).length).toBeLessThan(CHAT_BODY_LIMIT)
  }, 60_000)

  test('a small image still rides inline so vision gets its bytes on this turn', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
    const before = received.length
    const parts = await prepareOutgoingFiles(
      [{ name: 'pixel.png', type: 'image/png', size: png.length, dataUrl }],
      { agentUrl, fetchImpl: uploadFetch },
    )

    expect(parts[0].url).toBe(dataUrl)
    expect(parts[0].savedPath).toBeUndefined()
    expect(received.length).toBe(before)
  })
})

describe('AC3 — a later turn resends no attachment bytes', () => {
  test('reference parts pass through, a legacy data URL becomes a stub, body stays tiny', async () => {
    const legacyBytes = 12 * 1024 * 1024
    const legacyDataUrl = `data:application/zip;base64,${Buffer.from(
      pseudoRandomBytes(legacyBytes),
    ).toString('base64')}`

    const transcript = [
      // A row written by an old client, before this card.
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'old attachment' },
          { type: 'file', mediaType: 'application/zip', name: 'old.zip', url: legacyDataUrl },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'got it' }] },
      // This turn's history: a reference part from the new transport.
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'and the new one' },
          {
            type: 'file',
            mediaType: 'application/zip',
            name: 'bundle.zip',
            url: `${agentUrl}/agent/workspace/download/bundle.zip`,
            savedPath: 'bundle.zip',
          },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'unzipped' }] },
      { role: 'user', parts: [{ type: 'text', text: 'what is in it?' }] },
    ]

    const body = chatRequestBody(transcript)
    expect(body.length).toBeLessThan(CHAT_BODY_LIMIT)
    expect(body).not.toContain(';base64,')
    // The model is still told something was attached earlier.
    expect(body).toContain('old.zip')
    expect(body).toContain('was sent earlier in this chat')
    // The reference part is untouched.
    expect(body).toContain('"savedPath":"bundle.zip"')
  })

  test('a resend reuses the uploaded reference instead of uploading again', async () => {
    const before = received.length
    const parts = await prepareOutgoingFiles(
      [
        {
          name: 'bundle.zip',
          type: 'application/zip',
          savedPath: 'bundle.zip',
          dataUrl: `${agentUrl}/agent/workspace/download/bundle.zip`,
        },
      ],
      { agentUrl, fetchImpl: uploadFetch },
    )

    expect(received.length).toBe(before)
    expect(parts[0].savedPath).toBe('bundle.zip')
    expect(chatRequestBody([{ role: 'user', parts }]).length).toBeLessThan(CHAT_BODY_LIMIT)
  })
})

describe('AC7 — a refused upload surfaces the message and sends nothing', () => {
  test('over the cap: the runtime message is what the user sees, and the turn is not sent', async () => {
    refuseWith = {
      status: 413,
      code: 'attachment_too_large',
      message: '"huge.zip" is over the 2048 MB attachment limit.',
    }
    try {
      const bytes = pseudoRandomBytes(MAX_INLINE_FALLBACK_BYTES + 1024 * 1024)
      const attempt = prepareOutgoingFiles(
        [
          {
            name: 'huge.zip',
            type: 'application/zip',
            size: bytes.length,
            file: new File([bytes], 'huge.zip', { type: 'application/zip' }),
          },
        ],
        { agentUrl, fetchImpl: uploadFetch },
      )

      // No inline fallback is possible at this size — the send must fail rather
      // than quietly put the bytes back in the chat body.
      await expect(attempt).rejects.toThrow(/attachment limit/)
    } finally {
      refuseWith = null
    }
  }, 60_000)

  test('a small file falls back to inline bytes when the transport refuses the upload', async () => {
    refuseWith = {
      status: 501,
      code: 'attachment_upload_unsupported',
      message: 'Streamed attachment uploads are not available through a paired machine tunnel.',
    }
    try {
      const dataUrl = `data:text/plain;base64,${Buffer.from('small note').toString('base64')}`
      const parts = await prepareOutgoingFiles(
        [{ name: 'note.txt', type: 'text/plain', size: 10, dataUrl }],
        { agentUrl, fetchImpl: uploadFetch },
      )

      expect(parts[0].url).toBe(dataUrl)
      expect(parts[0].savedPath).toBeUndefined()
    } finally {
      refuseWith = null
    }
  })
})

/**
 * The pick has no data URL, so the bubble is painted from whatever else the
 * composer still holds. This is the round-1 blocker: `optimisticFileUrl` read
 * `dataUrl || uri` only, so a web/desktop pick of a large file or an archive
 * produced `file parts: []` and the user's own bubble showed a text-only turn
 * for the whole upload.
 */
describe('AC1/AC2 — the optimistic bubble shows a pick that has no data URL', () => {
  test('a large/archive web pick paints one file part before the upload runs', async () => {
    const { buildOptimisticUserMessage } = await import(
      '../../components/chat/optimistic-echo'
    )
    const { objectUrlFor } = await import('../composer-attachments')

    // Exactly what useComposerAttachments pushes for a large file or an
    // archive (composer-attachments.ts, the `isFileSizeExempt || size >
    // MAX_INLINE_PICK_BYTES` branch) — the same `objectUrlFor` helper it calls.
    const file = new File([pseudoRandomBytes(64)], 'bundle.zip', {
      type: 'application/zip',
    })
    const previewUrl = objectUrlFor(file)
    expect(previewUrl).toMatch(/^blob:/)

    const pick = {
      id: 'pick-1',
      dataUrl: '',
      name: 'bundle.zip',
      type: 'application/zip',
      size: 24 * 1024 * 1024,
      file,
      previewUrl: previewUrl ?? undefined,
    }

    const echo = buildOptimisticUserMessage({
      sessionId: 's-1',
      content: '',
      files: [pick],
    })
    const fileParts = (echo.parts as any[]).filter((p) => p.type === 'file')

    expect(fileParts).toHaveLength(1)
    expect(fileParts[0].name).toBe('bundle.zip')
    expect(fileParts[0].mediaType).toBe('application/zip')
    // The bubble paints the picked File through the object URL — never the
    // empty data URL, and never nothing at all (that was the round-1 bug).
    expect(fileParts[0].url).toBe(previewUrl)
  })

  test('the object URL is released, so a 200 MB pick is not held for the session', async () => {
    const { objectUrlFor, releasePreviewUrl } = await import(
      '../composer-attachments'
    )
    const file = new File([pseudoRandomBytes(32)], 'big.bin', {
      type: 'application/octet-stream',
    })
    const url = objectUrlFor(file)
    expect(url).toMatch(/^blob:/)

    const revoked: string[] = []
    const original = URL.revokeObjectURL
    URL.revokeObjectURL = ((value: string) => {
      revoked.push(value)
    }) as typeof URL.revokeObjectURL
    try {
      releasePreviewUrl(url ?? undefined)
      // A data URL or a workspace URL is not ours to revoke.
      releasePreviewUrl('data:application/zip;base64,AAAA')
      releasePreviewUrl('https://api.example.com/agent/workspace/download/x.zip')
      releasePreviewUrl(undefined)
    } finally {
      URL.revokeObjectURL = original
    }

    expect(revoked).toEqual([url as string])
  })
})

describe('AC10 — native uploads from the file uri, without base64', () => {
  test('the native branch is a binary PUT of the uri', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'chat-attachment-upload.ts'),
      'utf-8',
    )
    expect(src).toContain('createUploadTask(')
    expect(src).toContain('FileSystemUploadType.BINARY_CONTENT')
    // Base64 is only ever the fallback, and only when the bytes are already in
    // hand or the file is small enough for the old transport.
    expect(src).toContain('MAX_INLINE_FALLBACK_BYTES')
    const nativeBranch = src.slice(src.indexOf('if (file.uri)'), src.indexOf('} else {', src.indexOf('if (file.uri)')))
    expect(nativeBranch).not.toContain('readAsStringAsync')
  })
})

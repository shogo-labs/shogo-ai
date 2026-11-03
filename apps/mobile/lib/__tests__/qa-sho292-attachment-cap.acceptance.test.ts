// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-292 acceptance — the agent-chat composer's per-file cap is 100 MB.
 *
 * Drives the real composer hook (`useComposerAttachments.processFiles`, the
 * path web drop/paste/pick and the native picker both land on) and then the
 * real send-time helper (`prepareOutgoingFiles`) against a fetch stub standing
 * in for the runtime's `PUT /agent/chat/attachments`.
 *
 * Acceptance criteria covered: 1 (composer accepts up to 100 MB, rejects above
 * it with a 100 MB message), 3 (a 30 MB attachment reaches the agent through
 * the streamed upload, not a base64 data URL in the chat POST), 4 (archives
 * keep their exemption).
 */
import { describe, expect, mock, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
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

const { MAX_FILE_SIZE, useComposerAttachments } = await import('../composer-attachments')
const { prepareOutgoingFiles } = await import('../chat-attachment-upload')

const CHAT_BODY_LIMIT = 64 * 1024
const MB = 1024 * 1024

interface Received {
  name: string
  bytes: number
}

const received: Received[] = []
const agentUrl = 'https://api.example.com/api/workspaces/ws-1/agent-proxy'

const uploadFetch = (async (input: any, init: any) => {
  const url = new URL(String(input))
  const name = url.searchParams.get('name') ?? 'upload'
  const body = init?.body as { size?: number } | undefined
  const bytes = typeof body?.size === 'number' ? body.size : 0
  received.push({ name, bytes })
  return new Response(
    JSON.stringify({ savedPath: `files/${name}`, name, mediaType: 'application/octet-stream', bytes }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as unknown as typeof fetch

/** The body `useChatTransport.prepareSendMessagesRequest` puts on the wire. */
function chatRequestBody(parts: unknown[]): string {
  return JSON.stringify({
    id: 'chat-1',
    messages: trimLegacyInlineAttachments([
      { role: 'user', parts: [{ type: 'text', text: 'here is the file' }, ...parts] },
    ] as any),
    trigger: 'submit-message',
    messageId: 'msg-2',
  })
}

function bigFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('SHO-292 — the composer cap is 100 MB', () => {
  test('a 30 MB non-archive file is accepted, kept off the base64 path, and uploaded', async () => {
    const { result } = renderHook(() => useComposerAttachments({ enableDomEvents: false }))
    const file = bigFile('dataset.bin', 'application/octet-stream', 30 * MB)

    act(() => {
      result.current.processFiles([file])
    })

    // AC1: no size error at 30 MB (this is the case that failed at 10 MB).
    expect(result.current.fileError).toBeNull()
    expect(result.current.pendingFiles).toHaveLength(1)
    // AC3: the composer kept the File and read no bytes into a data URL.
    expect(result.current.pendingFiles[0].file).toBe(file)
    expect(result.current.pendingFiles[0].dataUrl).toBe('')

    const before = received.length
    const parts = await prepareOutgoingFiles([result.current.pendingFiles[0]], {
      agentUrl,
      fetchImpl: uploadFetch,
    })

    // AC3: the bytes went over PUT, and the chat body carries only a reference.
    expect(received.length).toBe(before + 1)
    expect(received[received.length - 1]).toEqual({ name: 'dataset.bin', bytes: 30 * MB })
    expect(parts[0].savedPath).toBe('files/dataset.bin')
    expect(parts[0].url.startsWith('data:')).toBe(false)
    const body = chatRequestBody(parts)
    expect(body.length).toBeLessThan(CHAT_BODY_LIMIT)
    expect(body).not.toContain(';base64,')
  }, 60_000)

  test('exactly 100 MB is accepted', () => {
    const { result } = renderHook(() => useComposerAttachments({ enableDomEvents: false }))

    act(() => {
      result.current.processFiles([bigFile('edge.bin', 'application/octet-stream', MAX_FILE_SIZE)])
    })

    expect(result.current.fileError).toBeNull()
    expect(result.current.pendingFiles).toHaveLength(1)
  })

  test('101 MB is refused with a message that says 100MB, and nothing is uploaded', () => {
    const { result } = renderHook(() => useComposerAttachments({ enableDomEvents: false }))
    const before = received.length

    act(() => {
      result.current.processFiles([bigFile('huge.bin', 'application/octet-stream', 101 * MB)])
    })

    expect(result.current.pendingFiles).toHaveLength(0)
    expect(result.current.fileError).toContain('huge.bin')
    expect(result.current.fileError).toContain('exceeds 100MB limit')
    expect(received.length).toBe(before)
  })

  test('archives keep their exemption above 100 MB', () => {
    const { result } = renderHook(() => useComposerAttachments({ enableDomEvents: false }))
    const originalReader = globalThis.FileReader
    class ImmediateFileReader {
      result: string | null = null
      onload: (() => void) | null = null
      readAsDataURL() {
        this.result = 'data:application/zip;base64,Zm9v'
        this.onload?.()
      }
    }
    globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader

    try {
      act(() => {
        result.current.processFiles([
          { name: 'project.zip', type: 'application/zip', size: 150 * MB } as File,
        ])
      })

      expect(result.current.fileError).toBeNull()
      expect(result.current.pendingFiles).toHaveLength(1)
    } finally {
      globalThis.FileReader = originalReader
    }
  })
})

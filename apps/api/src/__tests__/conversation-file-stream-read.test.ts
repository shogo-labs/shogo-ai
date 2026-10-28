// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `readConversationFileStream` reads the object as a stream.
 *
 * The PDF preview fetches a whole file through the API when the client cannot
 * follow the redirect (SHO-240). A 50 MB attachment must not be assembled in
 * memory to make that work, so the helper hands back the SDK's web stream and
 * never calls `transformToByteArray`.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const FILE_BYTES = new Uint8Array(300)

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

let transformToByteArrayCalls = 0

const send = mock(async (_command: any) => ({
  Body: {
    transformToWebStream: () => streamOf(FILE_BYTES),
    transformToByteArray: () => {
      transformToByteArrayCalls++
      throw new Error('the whole object must not be buffered')
    },
  },
  ContentLength: FILE_BYTES.byteLength,
  ContentType: 'application/pdf',
}))

const realS3 = await import('../lib/s3')
mock.module('../lib/s3', () => ({
  ...realS3,
  getArtifactS3Client: () => ({ send }),
  getArtifactBucket: () => 'artifacts-bucket',
}))

const { readConversationFileStream, wantsInlineBytes } = await import('../lib/conversation-files')

beforeEach(() => {
  send.mockClear()
  transformToByteArrayCalls = 0
})

describe('readConversationFileStream', () => {
  test('hands back a live stream with the object size and type', async () => {
    const file = await readConversationFileStream('artifacts/conversations/ws/conv/doc.pdf')

    expect(file.contentLength).toBe(FILE_BYTES.byteLength)
    expect(file.contentType).toBe('application/pdf')
    expect(file.body).toBeInstanceOf(ReadableStream)

    const command = send.mock.calls[0]![0] as any
    expect(command.input.Key).toBe('artifacts/conversations/ws/conv/doc.pdf')
    expect(command.input.Bucket).toBe('artifacts-bucket')
    expect(command.input.Range).toBeUndefined()

    expect(new Uint8Array(await new Response(file.body).arrayBuffer())).toEqual(FILE_BYTES)
    expect(transformToByteArrayCalls).toBe(0)
  })

  test('passes the range to the object store rather than slicing in memory', async () => {
    await readConversationFileStream('artifacts/conversations/ws/conv/doc.pdf', { range: { start: 0, end: 99 } })

    const command = send.mock.calls[0]![0] as any
    expect(command.input.Range).toBe('bytes=0-99')
    expect(transformToByteArrayCalls).toBe(0)
  })
})

describe('wantsInlineBytes', () => {
  const context = (mode?: string) => ({ req: { header: () => mode } })

  test('is true only for a script read', () => {
    expect(wantsInlineBytes(context('cors'))).toBe(true)
    expect(wantsInlineBytes(context('same-origin'))).toBe(true)
    expect(wantsInlineBytes(context('CORS'))).toBe(true)
  })

  test('is false for a navigation, a no-cors request and a client that sends nothing', () => {
    expect(wantsInlineBytes(context('navigate'))).toBe(false)
    expect(wantsInlineBytes(context('no-cors'))).toBe(false)
    expect(wantsInlineBytes(context(undefined))).toBe(false)
    expect(wantsInlineBytes(context(''))).toBe(false)
  })
})

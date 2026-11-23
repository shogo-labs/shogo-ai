// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-536 §A — the artifact a publish uploads must never become a V8 string.
//
// The publish that filed this card failed with `artifact_failed: "Cannot create a
// string longer than 2147483647 characters"`: the editing runtime had no object
// store, so it base64ed a ~1.7 GB tar into the JSON body. These cases drive the
// real upload against a stub runtime and assert the two halves of the fix — the
// presigned PUT the API mints for such a runtime, and the named refusal that
// replaces the crash when an older runtime still answers with base64.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createServer, type Server, type ServerResponse } from 'node:http'

mock.module('../../lib/prisma', () => ({ prisma: {} }))

const pod = { url: 'http://127.0.0.1:9' }
mock.module('../../lib/knative-project-manager', () => ({
  getProjectPodUrl: async () => pod.url,
}))
mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'rt-test',
}))

const s3Puts: Array<{ bucket: string; key: string; size: number }> = []
mock.module('../../lib/s3', () => ({
  getS3Client: () => ({
    send: async (command: any) => {
      if (command?.constructor?.name === 'PutObjectCommand') {
        s3Puts.push({
          bucket: command.input.Bucket,
          key: command.input.Key,
          size: command.input.Body?.length ?? 0,
        })
        return { ETag: '"etag"' }
      }
      return {}
    },
  }),
}))

const presignedUrls: Array<{ type: string; key: string; expiresIn?: number }> = []
mock.module('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: any, opts?: { expiresIn?: number }) => {
    presignedUrls.push({
      type: command?.constructor?.name,
      key: command?.input?.Key,
      expiresIn: opts?.expiresIn,
    })
    return `https://s3.internal/${command?.input?.Key}?X-Amz-Signature=test`
  },
}))

const { uploadPublishedArtifact } = await import('../published-build.service')

let server: Server | null = null
const requests: string[] = []
const originalEnv = { ...process.env }

async function listen(
  handler: (req: import('node:http').IncomingMessage, res: ServerResponse) => void,
): Promise<void> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind')
  pod.url = `http://127.0.0.1:${address.port}`
}

function respondJson(body: unknown, status = 200) {
  return (_req: unknown, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

beforeEach(async () => {
  process.env = { ...originalEnv, PUBLISH_BUCKET: 'test-publish-bucket' }
  s3Puts.length = 0
  presignedUrls.length = 0
  requests.length = 0
})

afterEach(async () => {
  process.env = { ...originalEnv }
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())))
    server = null
  }
})

const input = { projectId: 'proj-1', subdomain: 'acme', commitSha: 'abc123def4567890', alreadyBuilt: true }

describe('uploadPublishedArtifact', () => {
  it('hands the runtime a presigned PUT and takes its word for the key', async () => {
    await listen((req, res) => {
      requests.push(String(req.url))
      respondJson({ bucket: 'test-publish-bucket', key: 'acme/artifacts/abc123def4567890.tar.gz', bytes: 4096, offload: { skipped: 'no_object_store' } })(req, res)
    })

    const result = await uploadPublishedArtifact(input)

    if ('error' in result) throw new Error(result.error)
    expect(result.bytes).toBe(4096)
    // The URL the Job reads is a presigned GET over the same key.
    expect(result.url).toContain('acme/artifacts/abc123def4567890.tar.gz')
    // And the runtime was told where to PUT it, alongside the Job's GET.
    expect(presignedUrls).toEqual([
      { type: 'PutObjectCommand', key: 'acme/artifacts/abc123def4567890.tar.gz', expiresIn: 3600 },
      { type: 'GetObjectCommand', key: 'acme/artifacts/abc123def4567890.tar.gz', expiresIn: 3600 },
    ])
    const query = new URLSearchParams(requests[0].split('?')[1])
    expect(query.get('putUrl')).toContain('X-Amz-Signature=test')
    expect(query.get('bucket')).toBe('test-publish-bucket')
    // Nothing was uploaded from the API process: the runtime streamed it.
    expect(s3Puts).toEqual([])
  })

  it('refuses an over-cap inline body before decoding it, instead of crashing on the string', async () => {
    process.env.PUBLISH_ARTIFACT_INLINE_MAX_BYTES = '8'
    // 32 base64 characters = 24 bytes: three times the cap this test sets.
    await listen(respondJson({ archive: Buffer.alloc(24, 1).toString('base64'), bytes: 24 }))

    const result = await uploadPublishedArtifact(input)

    if (!('error' in result)) throw new Error('expected a refusal')
    expect(result.code).toBe('artifact_too_large')
    expect(result.error).toContain('artifact_too_large_for_inline')
    expect(result.error).toContain('must go through object storage')
    // The guard is a named refusal — it never reached S3, and never decoded.
    expect(s3Puts).toEqual([])
  })

  it('still accepts a small inline body from an older runtime', async () => {
    const archive = Buffer.from('tiny tarball bytes')
    await listen(respondJson({ archive: archive.toString('base64'), bytes: archive.length }))

    const result = await uploadPublishedArtifact(input)

    if ('error' in result) throw new Error(result.error)
    expect(result.bytes).toBe(archive.length)
    expect(s3Puts).toEqual([
      { bucket: 'test-publish-bucket', key: 'acme/artifacts/abc123def4567890.tar.gz', size: archive.length },
    ])
  })
})

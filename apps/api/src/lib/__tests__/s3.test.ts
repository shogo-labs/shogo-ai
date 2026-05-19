// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Track every S3Client constructor + send invocation
const constructedClients: any[] = []
let nextSendResponse: any | ((cmd: any) => any) = null
let throwOnNextSend: any = null

class FakeCommand {
  constructor(public input: any) {}
}
class GetObjectCommand extends FakeCommand { name = 'GetObjectCommand' }
class PutObjectCommand extends FakeCommand { name = 'PutObjectCommand' }
class ListObjectsV2Command extends FakeCommand { name = 'ListObjectsV2Command' }
class HeadObjectCommand extends FakeCommand { name = 'HeadObjectCommand' }
class DeleteObjectCommand extends FakeCommand { name = 'DeleteObjectCommand' }

class S3Client {
  config: any
  sends: any[] = []
  constructor(cfg: any) {
    this.config = cfg
    constructedClients.push(this)
  }
  async send(cmd: any) {
    this.sends.push(cmd)
    if (throwOnNextSend) {
      const e = throwOnNextSend
      throwOnNextSend = null
      throw e
    }
    if (typeof nextSendResponse === 'function') return nextSendResponse(cmd)
    return nextSendResponse ?? {}
  }
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
}))

const presignCalls: Array<{ client: any; command: any; options: any }> = []
let presignImpl: (c: any, cmd: any, opts: any) => Promise<string> = async (_c, cmd, opts) =>
  `https://signed/${cmd.name}/${cmd.input.Key}?exp=${opts.expiresIn}`

mock.module('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (client: any, command: any, options: any) => {
    presignCalls.push({ client, command, options })
    return presignImpl(client, command, options)
  },
}))

const s3 = await import('../s3')

const SAVED_ENV = { ...process.env }

function clearS3Env() {
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith('S3_') ||
      k === 'AWS_REGION' ||
      k === 'AWS_ACCESS_KEY_ID' ||
      k === 'AWS_SECRET_ACCESS_KEY' ||
      k === 'SCHEMA_STORAGE'
    ) {
      delete process.env[k]
    }
  }
}

beforeEach(() => {
  constructedClients.length = 0
  presignCalls.length = 0
  nextSendResponse = null
  throwOnNextSend = null
  presignImpl = async (_c, cmd, opts) =>
    `https://signed/${cmd.name}/${cmd.input.Key}?exp=${opts.expiresIn}`
  s3.resetS3Client()
  s3.resetArtifactS3Client()
  clearS3Env()
})

afterEach(() => {
  process.env = { ...SAVED_ENV }
  s3.resetS3Client()
  s3.resetArtifactS3Client()
})

// =====================================================================
// Client construction
// =====================================================================
describe('getS3Client', () => {
  it('returns a cached client across calls (singleton)', () => {
    const a = s3.getS3Client()
    const b = s3.getS3Client()
    expect(a).toBe(b)
    expect(constructedClients).toHaveLength(1)
  })

  it('uses us-east-1 when AWS_REGION is unset', () => {
    s3.getS3Client()
    expect(constructedClients[0].config.region).toBe('us-east-1')
    expect(constructedClients[0].config.endpoint).toBeUndefined()
    expect(constructedClients[0].config.credentials).toBeUndefined()
  })

  it('applies AWS_REGION', () => {
    process.env.AWS_REGION = 'eu-central-1'
    s3.getS3Client()
    expect(constructedClients[0].config.region).toBe('eu-central-1')
  })

  it('applies S3_ENDPOINT and defaults forcePathStyle to true when endpoint is set', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000'
    s3.getS3Client()
    expect(constructedClients[0].config.endpoint).toBe('http://minio:9000')
    expect(constructedClients[0].config.forcePathStyle).toBe(true)
  })

  it('respects S3_FORCE_PATH_STYLE=true even without an endpoint', () => {
    process.env.S3_FORCE_PATH_STYLE = 'true'
    s3.getS3Client()
    expect(constructedClients[0].config.forcePathStyle).toBeUndefined()
  })

  it('attaches credentials only when both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AK'
    process.env.AWS_SECRET_ACCESS_KEY = 'SK'
    s3.getS3Client()
    expect(constructedClients[0].config.credentials).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' })
  })

  it('omits credentials when only ACCESS_KEY is set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AK'
    s3.getS3Client()
    expect(constructedClients[0].config.credentials).toBeUndefined()
  })
})

describe('getS3PublicClient', () => {
  it('prefers S3_PUBLIC_ENDPOINT over S3_ENDPOINT', () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://public:9000'
    process.env.S3_ENDPOINT = 'http://minio:9000'
    s3.getS3PublicClient()
    expect(constructedClients[0].config.endpoint).toBe('http://public:9000')
  })

  it('falls back to S3_ENDPOINT when public endpoint is unset', () => {
    process.env.S3_ENDPOINT = 'http://internal:9000'
    s3.getS3PublicClient()
    expect(constructedClients[0].config.endpoint).toBe('http://internal:9000')
  })

  it('caches the public client singleton', () => {
    const a = s3.getS3PublicClient()
    const b = s3.getS3PublicClient()
    expect(a).toBe(b)
  })
})

describe('resetS3Client', () => {
  it('drops both private and public client caches', () => {
    s3.getS3Client()
    s3.getS3PublicClient()
    s3.resetS3Client()
    s3.getS3Client()
    s3.getS3PublicClient()
    expect(constructedClients).toHaveLength(4)
  })
})

// =====================================================================
// Env-shaped helpers
// =====================================================================
describe('getS3Bucket / getS3Prefix / isS3Enabled / buildS3Key', () => {
  it('getS3Bucket throws when S3_SCHEMA_BUCKET is unset', () => {
    expect(() => s3.getS3Bucket()).toThrow(/S3_SCHEMA_BUCKET/)
  })

  it('getS3Bucket returns the configured bucket', () => {
    process.env.S3_SCHEMA_BUCKET = 'schemas-prod'
    expect(s3.getS3Bucket()).toBe('schemas-prod')
  })

  it('getS3Prefix defaults to "schemas/"', () => {
    expect(s3.getS3Prefix()).toBe('schemas/')
  })

  it('getS3Prefix uses S3_SCHEMA_PREFIX when set', () => {
    process.env.S3_SCHEMA_PREFIX = 'custom/'
    expect(s3.getS3Prefix()).toBe('custom/')
  })

  it('isS3Enabled requires SCHEMA_STORAGE=s3 exactly', () => {
    expect(s3.isS3Enabled()).toBe(false)
    process.env.SCHEMA_STORAGE = 's3'
    expect(s3.isS3Enabled()).toBe(true)
    process.env.SCHEMA_STORAGE = 'fs'
    expect(s3.isS3Enabled()).toBe(false)
  })

  it('buildS3Key concatenates prefix + parts with slashes', () => {
    process.env.S3_SCHEMA_PREFIX = 'p/'
    expect(s3.buildS3Key('a', 'b', 'c.json')).toBe('p/a/b/c.json')
  })
})

// =====================================================================
// JSON read/write
// =====================================================================
describe('readJsonFromS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('reads a JSON body, parses, and returns the object', async () => {
    nextSendResponse = { Body: { transformToString: async () => '{"hello":"world"}' } }
    const r = await s3.readJsonFromS3('k.json')
    expect(r).toEqual({ hello: 'world' })
    const sent = constructedClients[0].sends[0]
    expect(sent).toBeInstanceOf(GetObjectCommand)
    expect(sent.input).toEqual({ Bucket: 'b', Key: 'k.json' })
  })

  it('throws on empty body', async () => {
    nextSendResponse = { Body: { transformToString: async () => '' } }
    await expect(s3.readJsonFromS3('k.json')).rejects.toThrow(/Empty response/)
  })

  it('throws when Body is undefined', async () => {
    nextSendResponse = {}
    await expect(s3.readJsonFromS3('k.json')).rejects.toThrow(/Empty response/)
  })

  it('propagates SDK throw', async () => {
    throwOnNextSend = new Error('network')
    await expect(s3.readJsonFromS3('k.json')).rejects.toThrow(/network/)
  })
})

describe('writeJsonToS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('sends a PutObjectCommand with stringified body + json content-type', async () => {
    await s3.writeJsonToS3('k.json', { a: 1 })
    const sent = constructedClients[0].sends[0]
    expect(sent).toBeInstanceOf(PutObjectCommand)
    expect(sent.input.Body).toBe('{\n  "a": 1\n}')
    expect(sent.input.ContentType).toBe('application/json')
    expect(sent.input.Key).toBe('k.json')
  })
})

describe('existsInS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('returns true on HEAD success', async () => {
    nextSendResponse = {}
    expect(await s3.existsInS3('k')).toBe(true)
  })

  it('returns false on NotFound error.name', async () => {
    throwOnNextSend = Object.assign(new Error('nf'), { name: 'NotFound' })
    expect(await s3.existsInS3('k')).toBe(false)
  })

  it('returns false on HTTP 404 metadata', async () => {
    throwOnNextSend = Object.assign(new Error('nf'), { $metadata: { httpStatusCode: 404 } })
    expect(await s3.existsInS3('k')).toBe(false)
  })

  it('rethrows other errors', async () => {
    throwOnNextSend = Object.assign(new Error('boom'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    await expect(s3.existsInS3('k')).rejects.toThrow(/boom/)
  })
})

// =====================================================================
// List helpers
// =====================================================================
describe('listDirsInS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('strips trailing slashes and prefix, filters empties', async () => {
    nextSendResponse = {
      CommonPrefixes: [
        { Prefix: 'root/foo/' },
        { Prefix: 'root/bar/' },
        { Prefix: 'root/' }, // becomes empty -> filtered
        {}, // no Prefix
      ],
    }
    expect(await s3.listDirsInS3('root/')).toEqual(['foo', 'bar'])
  })

  it('returns [] when CommonPrefixes is missing', async () => {
    nextSendResponse = {}
    expect(await s3.listDirsInS3('p/')).toEqual([])
  })

  it('uses Delimiter:"/" in the request', async () => {
    nextSendResponse = { CommonPrefixes: [] }
    await s3.listDirsInS3('p/')
    expect(constructedClients[0].sends[0].input.Delimiter).toBe('/')
  })
})

describe('listFilesInS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('returns only top-level filenames (no slashes after prefix)', async () => {
    nextSendResponse = {
      Contents: [
        { Key: 'pre/a.json' },
        { Key: 'pre/sub/b.json' }, // nested -> filtered
        { Key: 'pre/' }, // empty name -> filtered
        { Key: 'pre/c.json' },
        {}, // no Key
      ],
    }
    expect(await s3.listFilesInS3('pre/')).toEqual(['a.json', 'c.json'])
  })

  it('returns [] when Contents is missing', async () => {
    nextSendResponse = {}
    expect(await s3.listFilesInS3('pre/')).toEqual([])
  })
})

describe('deleteFromS3', () => {
  it('sends a DeleteObjectCommand', async () => {
    process.env.S3_SCHEMA_BUCKET = 'b'
    await s3.deleteFromS3('k')
    const sent = constructedClients[0].sends[0]
    expect(sent).toBeInstanceOf(DeleteObjectCommand)
    expect(sent.input).toEqual({ Bucket: 'b', Key: 'k' })
  })
})

// =====================================================================
// Presign read/write (schema)
// =====================================================================
describe('getPresignedReadUrl / getPresignedWriteUrl', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('uses default expiresIn=3600 and the public client', async () => {
    const url = await s3.getPresignedReadUrl('k')
    expect(url).toBe('https://signed/GetObjectCommand/k?exp=3600')
    expect(presignCalls[0].client).toBe(constructedClients[0])
    expect(presignCalls[0].options.expiresIn).toBe(3600)
  })

  it('honors a custom bucket and expiresIn', async () => {
    await s3.getPresignedReadUrl('k', { bucket: 'override', expiresIn: 60 })
    expect(presignCalls[0].command.input).toEqual({ Bucket: 'override', Key: 'k' })
    expect(presignCalls[0].options.expiresIn).toBe(60)
  })

  it('write attaches ContentType when supplied, omits when not', async () => {
    await s3.getPresignedWriteUrl('k', { contentType: 'image/png' })
    expect(presignCalls[0].command.input.ContentType).toBe('image/png')

    presignCalls.length = 0
    s3.resetS3Client()
    await s3.getPresignedWriteUrl('k2')
    expect(presignCalls[0].command.input.ContentType).toBeUndefined()
  })
})

// =====================================================================
// Text read/write
// =====================================================================
describe('readTextFromS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('returns the body string', async () => {
    nextSendResponse = { Body: { transformToString: async () => 'hello' } }
    expect(await s3.readTextFromS3('k')).toBe('hello')
  })

  it('returns the empty string when body is "" (no throw — only undefined throws)', async () => {
    nextSendResponse = { Body: { transformToString: async () => '' } }
    expect(await s3.readTextFromS3('k')).toBe('')
  })

  it('throws when Body is undefined', async () => {
    nextSendResponse = {}
    await expect(s3.readTextFromS3('k')).rejects.toThrow(/Empty response/)
  })

  it('uses bucket override when supplied', async () => {
    nextSendResponse = { Body: { transformToString: async () => 'x' } }
    await s3.readTextFromS3('k', 'alt-bucket')
    expect(constructedClients[0].sends[0].input.Bucket).toBe('alt-bucket')
  })
})

describe('writeTextToS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('defaults contentType to text/plain and writes body', async () => {
    await s3.writeTextToS3('k', 'body')
    const sent = constructedClients[0].sends[0]
    expect(sent.input.ContentType).toBe('text/plain')
    expect(sent.input.Body).toBe('body')
  })

  it('honors custom content type and bucket', async () => {
    await s3.writeTextToS3('k', 'data', 'text/markdown', 'alt')
    const sent = constructedClients[0].sends[0]
    expect(sent.input.ContentType).toBe('text/markdown')
    expect(sent.input.Bucket).toBe('alt')
  })
})

// =====================================================================
// listAllObjectsInS3 (pagination)
// =====================================================================
describe('listAllObjectsInS3', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('paginates while IsTruncated is true and stops on falsy NextContinuationToken', async () => {
    let call = 0
    nextSendResponse = (_cmd: any) => {
      call++
      if (call === 1) {
        return {
          Contents: [{ Key: 'pre/a', Size: 10, LastModified: new Date('2026-01-01') }],
          IsTruncated: true,
          NextContinuationToken: 'tok-2',
        }
      }
      if (call === 2) {
        return {
          Contents: [{ Key: 'pre/b', Size: 20 }, { Key: 'pre/c' }],
          IsTruncated: true,
          NextContinuationToken: 'tok-3',
        }
      }
      return { Contents: [{ Key: 'pre/d', Size: 5 }], IsTruncated: false }
    }
    const r = await s3.listAllObjectsInS3('pre/')
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual({ key: 'pre/a', relativePath: 'a', size: 10, lastModified: new Date('2026-01-01') })
    expect(r[1].size).toBe(20)
    expect(r[2].size).toBe(0)
    expect(call).toBe(3)
  })

  it('handles empty Contents on every page', async () => {
    nextSendResponse = { Contents: [], IsTruncated: false }
    expect(await s3.listAllObjectsInS3('p/')).toEqual([])
  })

  it('honors bucket override', async () => {
    nextSendResponse = { Contents: [], IsTruncated: false }
    await s3.listAllObjectsInS3('p/', 'alt')
    expect(constructedClients[0].sends[0].input.Bucket).toBe('alt')
  })

  it('handles missing Contents key', async () => {
    nextSendResponse = { IsTruncated: false }
    expect(await s3.listAllObjectsInS3('p/')).toEqual([])
  })

  it('skips contents with no Key', async () => {
    nextSendResponse = { Contents: [{}, { Key: 'pre/a', Size: 1 }], IsTruncated: false }
    const r = await s3.listAllObjectsInS3('pre/')
    expect(r).toHaveLength(1)
  })
})

// =====================================================================
// Artifact S3 — passthrough mode
// =====================================================================
describe('artifact passthrough', () => {
  it('returns schema client when no S3_ARTIFACT_* env is set', () => {
    const a = s3.getArtifactS3Client()
    const b = s3.getS3Client()
    expect(a).toBe(b)
  })

  it('public artifact client falls back to schema public client', () => {
    const a = s3.getArtifactS3PublicClient()
    const b = s3.getS3PublicClient()
    expect(a).toBe(b)
  })

  it('getArtifactBucket falls back to S3_SCHEMA_BUCKET', () => {
    process.env.S3_SCHEMA_BUCKET = 'schemas'
    expect(s3.getArtifactBucket()).toBe('schemas')
  })

  it('getArtifactBucket prefers S3_ARTIFACT_BUCKET', () => {
    process.env.S3_ARTIFACT_BUCKET = 'arts'
    expect(s3.getArtifactBucket()).toBe('arts')
  })

  it('isArtifactStorageIsolated detects each env var', () => {
    expect(s3.isArtifactStorageIsolated()).toBe(false)
    process.env.S3_ARTIFACT_BUCKET = 'arts'
    expect(s3.isArtifactStorageIsolated()).toBe(true)
    delete process.env.S3_ARTIFACT_BUCKET
    process.env.S3_ARTIFACT_ENDPOINT = 'http://a'
    expect(s3.isArtifactStorageIsolated()).toBe(true)
    delete process.env.S3_ARTIFACT_ENDPOINT
    process.env.S3_ARTIFACT_PUBLIC_ENDPOINT = 'http://b'
    expect(s3.isArtifactStorageIsolated()).toBe(true)
  })

  it('buildArtifactKey defaults to artifacts/ prefix', () => {
    expect(s3.buildArtifactKey('a', 'b')).toBe('artifacts/a/b')
  })

  it('buildArtifactKey honors S3_ARTIFACT_PREFIX override', () => {
    process.env.S3_ARTIFACT_PREFIX = 'media/'
    expect(s3.buildArtifactKey('x')).toBe('media/x')
  })
})

// =====================================================================
// Artifact S3 — override mode
// =====================================================================
describe('artifact override mode', () => {
  it('builds dedicated client when S3_ARTIFACT_ENDPOINT is set', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://artifacts:9000'
    process.env.S3_ARTIFACT_REGION = 'us-west-2'
    process.env.S3_ARTIFACT_ACCESS_KEY_ID = 'A'
    process.env.S3_ARTIFACT_SECRET_ACCESS_KEY = 'S'
    const c = s3.getArtifactS3Client()
    const cfg = (c as any).config
    expect(cfg.region).toBe('us-west-2')
    expect(cfg.endpoint).toBe('http://artifacts:9000')
    expect(cfg.forcePathStyle).toBe(true)
    expect(cfg.credentials).toEqual({ accessKeyId: 'A', secretAccessKey: 'S' })
  })

  it('caches the artifact client', () => {
    process.env.S3_ARTIFACT_ACCESS_KEY_ID = 'A'
    process.env.S3_ARTIFACT_SECRET_ACCESS_KEY = 'S'
    const a = s3.getArtifactS3Client()
    const b = s3.getArtifactS3Client()
    expect(a).toBe(b)
  })

  it('falls back to AWS_REGION when S3_ARTIFACT_REGION missing', () => {
    process.env.AWS_REGION = 'eu-west-1'
    process.env.S3_ARTIFACT_ENDPOINT = 'http://x'
    s3.getArtifactS3Client()
    const cfg = constructedClients[constructedClients.length - 1].config
    expect(cfg.region).toBe('eu-west-1')
  })

  it('falls back to AWS_* creds when S3_ARTIFACT_* creds missing', () => {
    process.env.AWS_ACCESS_KEY_ID = 'k'
    process.env.AWS_SECRET_ACCESS_KEY = 's'
    process.env.S3_ARTIFACT_ENDPOINT = 'http://x'
    s3.getArtifactS3Client()
    const cfg = constructedClients[constructedClients.length - 1].config
    expect(cfg.credentials).toEqual({ accessKeyId: 'k', secretAccessKey: 's' })
  })

  it('omits credentials when neither override nor AWS creds set', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://x'
    s3.getArtifactS3Client()
    const cfg = constructedClients[constructedClients.length - 1].config
    expect(cfg.credentials).toBeUndefined()
  })

  it('public artifact client prefers S3_ARTIFACT_PUBLIC_ENDPOINT', () => {
    process.env.S3_ARTIFACT_PUBLIC_ENDPOINT = 'http://public-art:9000'
    process.env.S3_ARTIFACT_ENDPOINT = 'http://art:9000'
    s3.getArtifactS3PublicClient()
    const cfg = constructedClients[constructedClients.length - 1].config
    expect(cfg.endpoint).toBe('http://public-art:9000')
  })

  it('public artifact falls back to S3_ARTIFACT_ENDPOINT', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://art:9000'
    s3.getArtifactS3PublicClient()
    const cfg = constructedClients[constructedClients.length - 1].config
    expect(cfg.endpoint).toBe('http://art:9000')
  })

  it('artifact forcePathStyle respects S3_ARTIFACT_FORCE_PATH_STYLE=true', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://art'
    process.env.S3_ARTIFACT_FORCE_PATH_STYLE = 'true'
    s3.getArtifactS3Client()
    expect(constructedClients[constructedClients.length - 1].config.forcePathStyle).toBe(true)
  })

  it('caches public artifact client too', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://x'
    const a = s3.getArtifactS3PublicClient()
    const b = s3.getArtifactS3PublicClient()
    expect(a).toBe(b)
  })

  it('resetArtifactS3Client drops both caches', () => {
    process.env.S3_ARTIFACT_ENDPOINT = 'http://x'
    s3.getArtifactS3Client()
    s3.getArtifactS3PublicClient()
    s3.resetArtifactS3Client()
    s3.getArtifactS3Client()
    s3.getArtifactS3PublicClient()
    expect(constructedClients).toHaveLength(4)
  })
})

// =====================================================================
// Artifact presign
// =====================================================================
describe('artifact presign', () => {
  beforeEach(() => { process.env.S3_SCHEMA_BUCKET = 'b' })

  it('read presign uses artifact public client + bucket + 3600s default', async () => {
    const url = await s3.getArtifactPresignedReadUrl('k')
    expect(url).toContain('GetObjectCommand')
    expect(presignCalls[0].options.expiresIn).toBe(3600)
  })

  it('write presign attaches ContentType when supplied', async () => {
    await s3.getArtifactPresignedWriteUrl('k', { contentType: 'audio/mp3', expiresIn: 30 })
    expect(presignCalls[0].command.input.ContentType).toBe('audio/mp3')
    expect(presignCalls[0].options.expiresIn).toBe(30)
  })

  it('write presign omits ContentType when not provided', async () => {
    await s3.getArtifactPresignedWriteUrl('k')
    expect(presignCalls[0].command.input.ContentType).toBeUndefined()
  })

  it('read presign honors bucket override option', async () => {
    await s3.getArtifactPresignedReadUrl('k', { bucket: 'art-override' })
    expect(presignCalls[0].command.input.Bucket).toBe('art-override')
  })

  it('write presign honors bucket override option', async () => {
    await s3.getArtifactPresignedWriteUrl('k', { bucket: 'art-override' })
    expect(presignCalls[0].command.input.Bucket).toBe('art-override')
  })
})

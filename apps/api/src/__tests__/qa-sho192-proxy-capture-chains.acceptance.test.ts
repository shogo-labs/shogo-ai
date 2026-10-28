// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance coverage for SHO-192 (append-only conversation chains).
 *
 * These run the real AI proxy route, the real capture normalizer, the real
 * archive queue and the real training export, and replace only external systems
 * (Prisma, the provider network, S3). The acceptance criteria exercised:
 *
 *  - a chain-node PUT that fails — including one another record started — makes
 *    the record store its messages inline and never reference the lost node;
 *  - a 20-call tool loop written as `both` round-trips through
 *    `training-export` with identical examples and a much smaller v2 archive;
 *  - a history over the 5 MB cap is stored untruncated as v2 (and exported)
 *    while the v1 layout still truncates it.
 */

import { gunzipSync } from 'node:zlib'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.AI_PROXY_SECRET = 'qa-sho192-proxy-capture-secret'
process.env.BETTER_AUTH_SECRET = 'qa-sho192-better-auth-secret'
process.env.PROXY_CAPTURE_ENABLED = 'true'
process.env.REGION_ID = 'test-region'
delete process.env.SHOGO_LOCAL_MODE
delete process.env.SHOGO_API_KEY
delete process.env.SHOGO_CLOUD_URL
process.env.OPENAI_API_KEY = 'sk-openai-qa-sho192'

interface StoredObject {
  Bucket: string
  Key: string
  Body: Buffer
  ContentType?: string
}

const stored: StoredObject[] = []
const chainPutAttempts = new Map<string, number>()
let failChainPuts = false
let chainGate: Promise<void> | null = null

const proxyTurnUpsert = mock(async (args: any) => args.create)

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    workspace: { findUnique: async () => ({ trainingDataMode: 'enabled' }) },
    workspaceModelVisibility: { findMany: async () => [] },
    proxyTurn: { upsert: proxyTurnUpsert },
    project: {
      findFirst: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
    usageWallet: {
      findUnique: async () => null,
      create: async (args: any) => args.data,
      update: async (args: any) => args.data,
      upsert: async (args: any) => args.create,
    },
    subscription: { findFirst: async () => null, upsert: async () => ({}) },
  },
}))

mock.module('../services/billing.service', () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  getEffectivePlanId: async () => 'pro',
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({
    code: reason ?? 'usage_limit_reached',
    message: 'usage limit reached',
  }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => ({
    fiveHour: { kind: 'five_hour', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
    weekly: { kind: 'weekly', usedUsd: 0, limitUsd: null, utilization: 0, resetsAt: null },
  }),
  ensureSystemWorkspace: async () => {},
  syncFromStripe: async () => {},
  allocateMonthlyIncluded: async () => {},
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({
    allowed: true,
    currentSize: 'micro',
    requiredSize: null,
  }),
}))

mock.module('../lib/proxy-billing-session', () => ({
  openSession: () => null,
  hasSession: () => false,
  hasActiveSession: () => false,
  accumulateUsage: async () => false,
  accumulateImageUsage: async () => false,
  setQualitySignals: () => false,
  closeSession: async () => null,
}))

mock.module('../lib/project-user-context', () => ({
  getProjectUser: () => 'user-1',
}))

mock.module('../lib/cloud-key-wipe', () => ({
  wipeCloudKey: async () => {},
  wipeCloudKeyIfRejected: async () => ({ wiped: false }),
}))

mock.module('@shogo-ai/sdk/vite-watch', () => ({
  killViteWatchFromPidfile: () => {},
}))

class FakePutObjectCommand {
  input: any

  constructor(input: any) {
    this.input = input
  }
}

class FakeS3Command {
  input: any

  constructor(input: any) {
    this.input = input
  }
}

// The bucket is the only external system whose failure matters here: every
// record the capture writes is a PUT, and chain nodes are the only objects a
// record depends on for its content.
const captureBucket = {
  async send(command: FakePutObjectCommand) {
    const key = command.input.Key as string
    if (key.includes('/chain/')) {
      chainPutAttempts.set(key, (chainPutAttempts.get(key) || 0) + 1)
      if (chainGate) await chainGate
      if (failChainPuts) throw new Error('capture bucket unavailable')
    }
    stored.push(command.input)
    return {}
  },
}

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: FakeS3Command,
  ListObjectsV2Command: FakeS3Command,
  HeadObjectCommand: FakeS3Command,
  DeleteObjectCommand: FakeS3Command,
  CopyObjectCommand: FakeS3Command,
  PutObjectCommand: FakePutObjectCommand,
}))

mock.module('../lib/s3', () => ({
  getLlmCaptureBucket: () => 'llm-captures-test',
  getS3Client: () => captureBucket,
  getLlmCaptureS3Client: () => captureBucket,
}))

let nextFetchResponses: Array<() => Response> = []
globalThis.fetch = (async () => {
  const next = nextFetchResponses.shift()
  if (next) return next()
  throw new Error('Unexpected provider request')
}) as any

const { Hono } = await import('hono')
const { aiProxyRoutes } = await import('../routes/ai-proxy')
const { generateProxyToken } = await import('../lib/ai-proxy-token')
const { clearConsentCache, flushAndStopArchive } = await import('../lib/proxy-capture')
const { reconstructRequest } = await import('../lib/proxy-capture/reconstruct')
const { stableStringify } = await import('../lib/proxy-capture/chain')
const { readArchiveFiles, selectExamples } = await import('../../../../scripts/training-export/index')

const TOKEN = await generateProxyToken('proj-1', 'ws-1', 'user-1')
const ROOT = resolve(`.tmp/qa-sho192-acceptance-${process.pid}`)

function postChat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = new Hono()
  app.route('/api', aiProxyRoutes())
  return app.fetch(new Request('http://test/api/ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  }))
}

function reply(step: number) {
  return () => new Response(JSON.stringify({
    id: `chatcmpl-qa-192-${step}`,
    choices: [{ message: { role: 'assistant', content: `step ${step}: ${noise(1_200)}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// Production messages are mostly unique text, so repeated history only shrinks
// as much as gzip can squeeze 48 copies of the same octets. Random tokens keep
// this fixture honest: compressible filler would flatter the v2 ratio.
let noiseState = 20261024
function noise(length: number): string {
  const words: string[] = []
  let size = 0
  while (size < length) {
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0
    const word = noiseState.toString(36)
    words.push(word)
    size += word.length + 1
  }
  return words.join(' ')
}

function toolLoop(step: number, resultBytes = 2_000): any[] {
  return [
    { role: 'assistant', content: `step ${step}: ${noise(1_200)}` },
    {
      role: 'tool',
      tool_call_id: `call-${step}`,
      content: JSON.stringify({ rows: noise(resultBytes) }),
    },
  ]
}

function storedRecords(format: 'v1' | 'v2'): any[] {
  return stored
    .filter((write) => write.ContentType === 'application/jsonl' && write.Key.startsWith(`${format}/region=`))
    .flatMap((write) => gunzipSync(write.Body).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
}

function chainObjects(): StoredObject[] {
  return stored.filter((write) => write.Key.includes('/chain/'))
}

function bytesOf(keys: string[]): number {
  return keys.reduce((sum, key) => sum + (stored.find((write) => write.Key === key)?.Body.byteLength || 0), 0)
}

async function writeArchiveTree(dir: string, keep: (key: string) => boolean): Promise<void> {
  for (const write of stored.filter((object) => keep(object.Key))) {
    const target = join(dir, write.Key)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, write.Body)
  }
}

beforeEach(() => {
  nextFetchResponses = []
  stored.length = 0
  chainPutAttempts.clear()
  failChainPuts = false
  chainGate = null
  clearConsentCache()
  delete process.env.PROXY_CAPTURE_ARCHIVE_FORMAT
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('SHO-192 chain archive acceptance', () => {
  test('a failed chain-node PUT stores the record inline and never references the node', async () => {
    const history: any[] = [
      { role: 'system', content: 'You are a release agent.' },
      { role: 'user', content: 'Investigate the failing deploy.' },
    ]
    for (let step = 0; step < 8; step += 1) history.push(...toolLoop(step))
    expect(storedRecords('v2')).toHaveLength(0)

    failChainPuts = true
    nextFetchResponses.push(reply(99))
    expect((await postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-fault' })).status).toBe(200)
    await flushAndStopArchive()

    const failed = storedRecords('v2').at(-1)!
    expect(failed.request.chain).toBeUndefined()
    expect(failed.request.messages).toHaveLength(history.length)
    expect(failed.truncated).toBe(false)
    expect(chainObjects()).toHaveLength(0)

    // A node another record already started uploading fails the same way: both
    // records fall back to inline rather than pointing at an object that never
    // landed, and the shared upload is only ever issued once.
    failChainPuts = false
    chainPutAttempts.clear()
    let release!: () => void
    chainGate = new Promise((resolveGate) => { release = resolveGate })
    nextFetchResponses.push(reply(100), reply(101))
    const first = postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-shared-a' })
    const second = postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-shared-b' })
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)

    failChainPuts = true
    release()
    chainGate = null
    await flushAndStopArchive()

    const shared = storedRecords('v2').slice(-2)
    expect(shared).toHaveLength(2)
    for (const record of shared) {
      expect(record.request.chain).toBeUndefined()
      expect(record.request.messages).toHaveLength(history.length)
    }
    expect(chainObjects()).toHaveLength(0)
    // One attempt per distinct node, no matter how many records referenced it.
    const attempts = [...chainPutAttempts.values()]
    expect(attempts.length).toBeGreaterThan(0)
    expect(attempts.every((count) => count === 1)).toBe(true)

    // Once the bucket recovers the same history chains again.
    failChainPuts = false
    nextFetchResponses.push(reply(102))
    expect((await postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-recovered' })).status).toBe(200)
    await flushAndStopArchive()

    const recovered = storedRecords('v2').at(-1)!
    expect(recovered.request.chain).toBeDefined()
    expect(recovered.request.messages).toBeUndefined()
    const load = async (key: string): Promise<unknown> => {
      const object = stored.find((write) => write.Key === key)
      return object ? JSON.parse(gunzipSync(object.Body).toString('utf8')) : null
    }
    const rebuilt = await reconstructRequest(recovered, load) as any
    expect(rebuilt.messages).toHaveLength(history.length)
    expect(stableStringify(rebuilt.messages)).toBe(stableStringify(history))
  })

  test('a 20-call tool loop round-trips through training-export with identical examples', async () => {
    const history: any[] = [
      { role: 'system', content: 'You are a release agent.' },
      { role: 'user', content: 'Investigate the failing deploy and report back.' },
    ]
    for (let step = 0; step < 20; step += 1) {
      nextFetchResponses.push(reply(step))
      const response = await postChat(
        { model: 'gpt-4o-mini', messages: [...history] },
        { 'x-chat-session-id': 'session-tool-loop' },
      )
      expect(response.status).toBe(200)
      history.push(...toolLoop(step))
    }
    await flushAndStopArchive()

    const v1Records = storedRecords('v1')
    const v2Records = storedRecords('v2')
    expect(v1Records).toHaveLength(20)
    expect(v2Records).toHaveLength(20)
    // The first call of the loop is only two messages, so it has no boundary and
    // stays inline; every call after it chains.
    expect(v2Records[0]!.request.messages).toHaveLength(2)
    expect(v2Records.slice(1).every((record) => record.request.chain)).toBe(true)
    expect(chainObjects().length).toBeGreaterThan(0)

    const v1Keys = stored.map((write) => write.Key).filter((key) => key.startsWith('v1/'))
    const v2Keys = stored.map((write) => write.Key).filter((key) => key.startsWith('v2/'))
    // Blobs are written by both layouts, so both sides carry them.
    const blobs = stored.map((write) => write.Key).filter((key) => key.includes('/blobs/') || key.includes('/media/'))
    const v1Bytes = bytesOf(v1Keys) + bytesOf(blobs)
    const v2Bytes = bytesOf(v2Keys) + bytesOf(blobs)
    // A turn of n calls re-sends a growing history, so the most a chain can save
    // here is about n/2 (4-5x at 20 calls) once per-object gzip overhead is
    // counted. The >=20x acceptance number is the replay script's 120-call
    // fixture, measured separately on this card.
    expect(v1Bytes / v2Bytes).toBeGreaterThan(3)

    const v1Dir = join(ROOT, 'loop-v1')
    const v2Dir = join(ROOT, 'loop-v2')
    await writeArchiveTree(v1Dir, (key) => key.startsWith('v1/'))
    await writeArchiveTree(v2Dir, (key) => key.startsWith('v1/blobs/') || key.startsWith('v2/'))

    // Every call of the loop carries the same user text, so they share a turnKey
    // and the export keeps one example per turn: the last call, whose history
    // already contains every earlier step.
    const fromV1 = await selectExamples(await readArchiveFiles(v1Dir))
    const fromV2 = await selectExamples(await readArchiveFiles(v2Dir))
    expect(fromV2).toHaveLength(1)
    expect(JSON.stringify(fromV2)).toBe(JSON.stringify(fromV1))
    // Whole history rebuilt from the chain, not just the record's own tail.
    expect(fromV2[0]!.messages.length).toBeGreaterThan(30)
  })

  test('writes only the v2 layout once the format flag flips', async () => {
    process.env.PROXY_CAPTURE_ARCHIVE_FORMAT = 'v2'
    const history: any[] = [
      { role: 'system', content: 'You are a release agent.' },
      { role: 'user', content: 'Investigate the failing deploy.' },
    ]
    for (let step = 0; step < 8; step += 1) history.push(...toolLoop(step))

    nextFetchResponses.push(reply(0))
    expect((await postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-v2-only' })).status).toBe(200)
    await flushAndStopArchive()

    expect(storedRecords('v1')).toHaveLength(0)
    const records = storedRecords('v2')
    expect(records).toHaveLength(1)
    expect(records[0]!.request.chain).toBeDefined()
    const summary = proxyTurnUpsert.mock.calls.at(-1)![0] as any
    expect(summary.create.archivePrefix).toStartWith('v2/region=')
    expect(summary.create.truncated).toBe(false)
  })

  test('a history over the 5 MB cap is stored untruncated as v2 and exported', async () => {
    const history: any[] = [{ role: 'system', content: 'You are a release agent.' }]
    for (let index = 0; index < 200; index += 1) {
      history.push({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(30_000) })
    }
    expect(JSON.stringify(history).length).toBeGreaterThan(5 * 1024 * 1024)

    nextFetchResponses.push(reply(0))
    expect((await postChat({ model: 'gpt-4o-mini', messages: history }, { 'x-chat-session-id': 'session-large' })).status).toBe(200)
    await flushAndStopArchive()

    const v2Record = storedRecords('v2').at(-1)!
    expect(v2Record.truncated).toBe(false)
    expect(v2Record.request.chain).toBeDefined()
    const v1Record = storedRecords('v1').at(-1)!
    expect(v1Record.truncated).toBe(true)

    const v1Dir = join(ROOT, 'large-v1')
    const v2Dir = join(ROOT, 'large-v2')
    await writeArchiveTree(v1Dir, (key) => key.startsWith('v1/'))
    await writeArchiveTree(v2Dir, (key) => key.startsWith('v1/blobs/') || key.startsWith('v2/'))

    // The v1 export drops the turn because it was truncated; the v2 export keeps
    // it in full. That difference is the point of the change, not drift. The
    // export's own max-chars cap (1 MB by default) still drops an example this
    // large, so raise it to isolate the truncation behaviour.
    expect(await selectExamples(await readArchiveFiles(v1Dir), { maxChars: 10_000_000 })).toHaveLength(0)
    const fromV2 = await selectExamples(await readArchiveFiles(v2Dir), { maxChars: 10_000_000 })
    expect(fromV2).toHaveLength(1)
    expect(fromV2[0]!.messages).toHaveLength(history.length + 1)
    expect(await selectExamples(await readArchiveFiles(v2Dir))).toHaveLength(0)
  })
})

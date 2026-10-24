#!/usr/bin/env bun

/**
 * Replays a v1 proxy capture through the v2 chain normalizer and reports what
 * the same traffic would have cost.
 *
 *   bun scripts/proxy-capture-replay/index.ts --input <dir|s3://bucket/prefix>
 *   bun scripts/proxy-capture-replay/index.ts --synthetic --input .tmp/fixture --chunk 1,2,4
 *
 * `--writers N` runs N independent writer states (each with its own daily dedupe
 * maps, like N api pods) and assigns every record to one of them at random.
 * Node keys are content-defined, so N only changes how many PUTs each node
 * costs, never which nodes exist.
 */

import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { chainRequest, stableStringify } from '../../apps/api/src/lib/proxy-capture/chain'
import { reconstructRequest } from '../../apps/api/src/lib/proxy-capture/reconstruct'

interface ArchiveRecord {
  id: string
  ts: string
  workspaceId: string
  turnKey: string
  request?: any
  response?: any
  [key: string]: unknown
}

interface Archive {
  records: ArchiveRecord[]
  objects: Map<string, Uint8Array>
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

// `--chunk 1,2,4` and `--writers 1,3` run every combination. A bad value is a
// usage error, never a silent zero: a pass with no writer state has no dedupe
// state to reuse and cannot report a ratio.
function numberList(value: string | boolean | undefined, fallback: string): number[] {
  const raw = typeof value === 'string' ? value : fallback
  const values = raw.split(',').map((item) => Number(item.trim())).filter((item) => Number.isFinite(item) && item >= 1)
  if (values.length === 0) throw new Error(`expected a positive number or a comma-separated list, got "${raw}"`)
  return values
}

function isRecordFile(key: string): boolean {
  return key.endsWith('.jsonl') || key.endsWith('.jsonl.gz')
}

function parseBlob(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(gunzipSync(bytes).toString('utf8'))
  } catch {
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      return null
    }
  }
}

async function readLocal(input: string): Promise<Archive> {
  const root = resolve(input)
  const files = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: root, absolute: true, onlyFiles: true }))
  const records: ArchiveRecord[] = []
  const objects = new Map<string, Uint8Array>()
  for (const file of files) {
    const key = relative(root, file).replace(/\\/g, '/')
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (isRecordFile(key)) {
      const text = (key.endsWith('.gz') ? gunzipSync(bytes) : Buffer.from(bytes)).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line))
        } catch {
          console.warn(`[replay] skipping malformed line in ${key}`)
        }
      }
    } else {
      objects.set(key, bytes)
    }
  }
  return { records, objects }
}

async function readS3(uri: string): Promise<Archive> {
  const { S3Client, GetObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const parsed = new URL(uri)
  const bucket = parsed.hostname
  const prefix = parsed.pathname.replace(/^\/+/, '')
  const endpoint = process.env.S3_LLM_CAPTURES_ENDPOINT || process.env.S3_ENDPOINT
  const client = new S3Client({
    region: process.env.S3_LLM_CAPTURES_REGION || process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    endpoint,
    forcePathStyle: Boolean(endpoint),
  })
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))
    keys.push(...(listed.Contents || []).map((item: any) => item.Key).filter((key: unknown): key is string => typeof key === 'string'))
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)

  const records: ArchiveRecord[] = []
  const objects = new Map<string, Uint8Array>()
  for (const key of keys) {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const bytes = await object.Body!.transformToByteArray()
    if (isRecordFile(key)) {
      const text = (key.endsWith('.gz') ? gunzipSync(bytes) : Buffer.from(bytes)).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line))
        } catch {
          console.warn(`[replay] skipping malformed line in ${key}`)
        }
      }
    } else {
      objects.set(key, bytes)
    }
  }
  return { records, objects }
}

function reader(archive: Archive) {
  const parsed = new Map<string, unknown>()
  return async (key: string): Promise<unknown> => {
    if (parsed.has(key)) return parsed.get(key)
    const bytes = archive.objects.get(key)
    const value = bytes ? parseBlob(bytes) : null
    parsed.set(key, value)
    return value
  }
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (typeof record.$ref === 'string') refs.add(record.$ref)
  for (const item of Object.values(record)) collectRefs(item, refs)
}

// One api pod's writer state: blobs and nodes it has already PUT today.
class PodState {
  private day = ''
  readonly blobs = new Set<string>()
  readonly nodes = new Set<string>()

  roll(ts: string): void {
    const day = ts.slice(0, 10)
    if (day === this.day) return
    this.day = day
    this.blobs.clear()
    this.nodes.clear()
  }
}

interface PassResult {
  chunk: number
  writers: number
  records: number
  v1Bytes: number
  v2Bytes: number
  v1Objects: number
  v2Objects: number
  nodes: number
  nodePuts: number
  mismatches: number
  sample?: string
}

const REGION = process.env.REGION_ID || 'replay'

function partition(format: 'v1' | 'v2', ts: string, pod: number): string {
  return `${format}/region=${REGION}/date=${ts.slice(0, 10)}/hour=${ts.slice(11, 13)}/writer-${pod}`
}

async function runPass(
  archive: Archive,
  chunk: number,
  writers: number,
  seed: number,
): Promise<{ result: PassResult; files: Map<string, Uint8Array> }> {
  process.env.PROXY_CAPTURE_CHAIN_CHUNK = String(chunk)
  const load = reader(archive)
  const pods = Array.from({ length: writers }, () => new PodState())
  const files = new Map<string, Uint8Array>()
  const lines = new Map<string, string[]>()
  const nodeBodies = new Map<string, unknown>()
  const v1Records: ArchiveRecord[] = []
  const v2Records: ArchiveRecord[] = []
  let nodePuts = 0
  let blobBytes = 0
  // Reconstruction reads only what a real reader would have: the stored archive
  // objects plus the node objects this pass wrote.
  const loadForRecord = async (key: string): Promise<unknown> =>
    nodeBodies.has(key) ? nodeBodies.get(key) : load(key)

  // Deterministic pod assignment: the same record lands on the same pod in every
  // run, so --writers 1 and --writers 3 measure the same traffic.
  const podFor = (index: number): number => {
    const hash = createHash('sha256').update(`${seed}\0${archive.records[index].id}`).digest()
    return hash.readUInt32BE(0) % writers
  }

  for (const [index, record] of archive.records.entries()) {
    if (!record?.request || !record?.response) continue
    const pod = pods[podFor(index)]
    pod.roll(record.ts)
    const podIndex = podFor(index)

    const refs = new Set<string>()
    collectRefs(record.request, refs)
    for (const ref of refs) {
      const bytes = archive.objects.get(ref)
      if (!bytes) continue
      if (pod.blobs.has(ref)) continue
      pod.blobs.add(ref)
      blobBytes += bytes.byteLength
    }

    const chained = chainRequest(record.request, record.workspaceId, (key, body) => {
      nodeBodies.set(key, body)
      if (!pod.nodes.has(key)) {
        pod.nodes.add(key)
        nodePuts += 1
        files.set(key, gzipSync(Buffer.from(JSON.stringify(body))))
      }
      return Promise.resolve()
    })

    v1Records.push(record)
    v2Records.push({ ...record, request: chained.request })
    appendLine(lines, partition('v1', record.ts, podIndex), JSON.stringify(record))
    appendLine(lines, partition('v2', record.ts, podIndex), JSON.stringify({ ...record, request: chained.request }))
  }

  for (const [prefix, batch] of lines) {
    files.set(`${prefix}/batch.jsonl.gz`, gzipSync(Buffer.from(batch.join(''))))
  }

  let mismatches = 0
  let sample: string | undefined
  for (const [index, v2Record] of v2Records.entries()) {
    const expected = stableStringify(await reconstructRequest(v1Records[index], loadForRecord))
    const actual = stableStringify(await reconstructRequest(v2Record, loadForRecord))
    if (expected === actual) continue
    mismatches += 1
    sample ??= `${v1Records[index].id}: expected ${expected.slice(0, 160)} / got ${actual.slice(0, 160)}`
  }

  const v1Keys = [...files.keys()].filter((key) => key.startsWith('v1/'))
  const v2Keys = [...files.keys()].filter((key) => key.startsWith('v2/'))
  const total = (keys: string[]): number => keys.reduce((sum, key) => sum + (files.get(key)?.byteLength || 0), 0)
  const nodeCount = [...files.keys()].filter((key) => key.includes('/chain/')).length

  return {
    files,
    result: {
      chunk,
      writers,
      records: v2Records.length,
      // Blobs and media are written by both formats, so both sides carry them.
      v1Bytes: total(v1Keys) + blobBytes,
      v2Bytes: total(v2Keys) + blobBytes,
      v1Objects: v1Keys.length + archive.objects.size,
      v2Objects: v2Keys.length + archive.objects.size,
      nodes: nodeCount,
      nodePuts,
      mismatches,
      ...(sample ? { sample } : {}),
    },
  }
}

function appendLine(lines: Map<string, string[]>, prefix: string, line: string): void {
  const batch = lines.get(prefix)
  if (batch) batch.push(`${line}\n`)
  else lines.set(prefix, [`${line}\n`])
}

async function writeOutput(dir: string, result: PassResult, files: Map<string, Uint8Array>): Promise<string> {
  const root = resolve(dir, `chunk-${result.chunk}-writers-${result.writers}`)
  for (const [key, bytes] of files) {
    const target = resolve(root, key)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, bytes)
  }
  return root
}

const WORDS = ['deploy', 'schema', 'gateway', 'queue', 'artifact', 'worker', 'retry', 'tenant', 'migration', 'capture', 'payload', 'region']

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Writes a v1-shaped capture that looks like production: several agent sessions
 * of tool calls, each re-sending the whole conversation, with the system prompt
 * content-addressed the way the v1 normalizer stores it.
 */
async function writeSynthetic(dir: string, sessions: number, calls: number, toolBytes: number): Promise<void> {
  const root = resolve(dir)
  const random = mulberry32(20261024)
  const filler = (): string => {
    const parts: string[] = []
    let length = 0
    while (length < toolBytes) {
      const word = `${WORDS[Math.floor(random() * WORDS.length)]}-${Math.floor(random() * 1e6).toString(36)}`
      parts.push(word)
      length += word.length + 1
    }
    return parts.join(' ')
  }

  for (let session = 0; session < sessions; session += 1) {
    const sessionId = `session-${session}`
    const workspaceId = `workspace-${session % 2}`
    const systemPrompt = JSON.stringify([{ type: 'text', text: `You are agent ${session}. ${'rules '.repeat(200)}` }])
    const systemHash = createHash('sha256').update(systemPrompt).digest('hex')
    const systemKey = `v1/blobs/${systemHash}.json.gz`
    await mkdir(join(root, dirname(systemKey)), { recursive: true })
    await Bun.write(join(root, systemKey), gzipSync(Buffer.from(systemPrompt)))

    const messages: any[] = [
      { role: 'system', content: { $ref: systemKey, kind: 'system' } },
      { role: 'user', content: `session ${session}: ${filler()}` },
    ]
    const lines: string[] = []
    for (let call = 0; call < calls; call += 1) {
      const ts = new Date(Date.UTC(2026, 9, 21, 9 + Math.floor(call / 20), call % 60)).toISOString()
      const request = {
        model: 'claude-sonnet-4-5',
        system: { $ref: systemKey, kind: 'system' },
        tools: [{ type: 'function', name: 'run_tool', parameters: { type: 'object' } }],
        messages: [...messages],
      }
      const response = {
        id: `resp-${session}-${call}`,
        choices: [{ message: { role: 'assistant', content: `step ${call} of ${sessionId} done` } }],
      }
      lines.push(JSON.stringify({
        id: `${sessionId}-${call}`,
        ts,
        source: 'cloud_runtime',
        workspaceId,
        chatSessionId: sessionId,
        turnKey: createHash('sha256').update(`${sessionId}:${call}`).digest('hex'),
        endpoint: 'chat.completions',
        provider: 'anthropic',
        resolvedModel: 'claude-sonnet-4-5',
        request,
        response,
      }))
      messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${session}_${call}`, name: 'run_tool', input: { step: call } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${session}_${call}`, content: `[${filler()}]` }] },
      )
    }
    const key = `v1/region=${REGION}/date=2026-10-21/hour=09/${sessionId}.jsonl.gz`
    await mkdir(join(root, dirname(key)), { recursive: true })
    await Bun.write(join(root, key), gzipSync(Buffer.from(lines.join('\n') + '\n')))
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const input = String(args.input || '')
  if (!input) throw new Error('--input <capture-directory|s3://bucket/prefix> is required')

  if (args.synthetic) {
    const sessions = Number(args.sessions || 4)
    const calls = Number(args.calls || 120)
    const toolBytes = Number(args['tool-bytes'] || 2500)
    console.log(`[replay] writing synthetic fixture to ${input} (${sessions} sessions x ${calls} calls)`)
    await writeSynthetic(input, sessions, calls, toolBytes)
  }

  const archive = input.startsWith('s3://') ? await readS3(input) : await readLocal(input)
  if (archive.records.length === 0) throw new Error(`no archive records found under ${input}`)
  const workspaces = new Set(archive.records.map((record) => record.workspaceId))
  console.log(`[replay] ${archive.records.length} records, ${workspaces.size} workspaces, ${archive.objects.size} stored objects`)

  const chunks = numberList(args.chunk, '2')
  const writerCounts = numberList(args.writers, '3')
  const output = typeof args.output === 'string' ? args.output : null

  for (const chunk of chunks) {
    for (const writers of writerCounts) {
      const { result, files } = await runPass(archive, chunk, writers, 20261024)
      if (output) {
        const written = await writeOutput(output, result, files)
        console.log(`[replay] wrote ${written}`)
      }
      const ratio = result.v2Bytes > 0 ? result.v1Bytes / result.v2Bytes : 0
      console.log([
        `chunk=${result.chunk} writers=${result.writers} records=${result.records}`,
        `  v1 ${formatBytes(result.v1Bytes)} in ${result.v1Objects} objects`,
        `  v2 ${formatBytes(result.v2Bytes)} in ${result.v2Objects} objects (${result.nodes} chain nodes, ${result.nodePuts} node PUTs)`,
        `  ratio ${ratio.toFixed(1)}x`,
        `  reconstruction ${result.mismatches === 0 ? 'identical' : `${result.mismatches} MISMATCH`}`,
        ...(result.sample ? [`  first mismatch ${result.sample}`] : []),
      ].join('\n'))
    }
  }
}

if (import.meta.main) {
  await main()
}

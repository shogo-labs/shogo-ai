#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

export interface ArchiveRecord {
  id: string
  ts: string
  workspaceId: string
  turnKey: string
  source?: string
  provider?: string
  requestedModel?: string | null
  resolvedModel?: string | null
  reasoningEffort?: string | null
  errorType?: string | null
  request?: any
  response?: any
  truncated?: boolean
}

export interface TrainingExample {
  id: string
  source: string
  model: string | null
  reasoning_effort?: string
  tools?: any[]
  messages: any[]
  media?: Array<{ hash: string; mime: string; path: string }>
  signals: {
    feedback: string | null
    reverted: boolean
    hadError: boolean
    truncated: boolean
  }
}

const MAX_EXAMPLE_CHARS = Number(process.env.TRAINING_EXPORT_MAX_CHARS || 1_000_000)
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
]
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g,
]

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function scrubText(value: string): { value: string; secretFound: boolean } {
  let result = value
  let secretFound = false
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(result)) secretFound = true
    result = result.replace(pattern, '[REDACTED_SECRET]')
    pattern.lastIndex = 0
  }
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_PII]')
    pattern.lastIndex = 0
  }
  return { value: result, secretFound }
}

function scrubValue(value: any): { value: any; secretFound: boolean } {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) {
    let secretFound = false
    const values = value.map((item) => {
      const result = scrubValue(item)
      secretFound ||= result.secretFound
      return result.value
    })
    return { value: values, secretFound }
  }
  if (!value || typeof value !== 'object') return { value, secretFound: false }
  let secretFound = false
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const result = scrubValue(item)
    secretFound ||= result.secretFound
    output[key] = result.value
  }
  return { value: output, secretFound }
}

function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => part?.text || part?.content || '').filter(Boolean).join('')
}

function normalizeMessage(message: any): any {
  if (!message || typeof message !== 'object') return message
  const role = message.role || 'user'
  const content = message.content
  if (role === 'assistant' && Array.isArray(content)) {
    const text = content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('')
    const reasoning = content.filter((part) => part?.type === 'thinking' || part?.type === 'redacted_thinking')
      .map((part) => part.thinking || part.text || '').join('')
    const toolCalls = content
      .filter((part) => part?.type === 'tool_use')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
      }))
    return {
      role,
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  }
  if (role === 'user' && Array.isArray(content)) {
    const toolResults = content.filter((part) => part?.type === 'tool_result')
    if (toolResults.length && toolResults.length === content.length) {
      return toolResults.map((part) => ({
        role: 'tool',
        tool_call_id: part.tool_use_id,
        content: contentText(part.content),
      }))
    }
  }
  return {
    ...message,
    ...(content !== undefined ? { content: contentText(content) || content } : {}),
  }
}

function normalizeMessages(request: any): any[] {
  const messages = Array.isArray(request?.messages) ? request.messages : request?.input
  const normalized: any[] = []
  if (request?.system) {
    const system = Array.isArray(request.system)
      ? request.system.map((part: any) => part?.text || part?.content || '').filter(Boolean).join('\n')
      : request.system
    if (system) normalized.push({ role: 'system', content: contentText(system) || system })
  }
  if (!Array.isArray(messages)) return normalized
  normalized.push(...messages.flatMap((message) => {
    const normalized = normalizeMessage(message)
    return Array.isArray(normalized) ? normalized : [normalized]
  }))
  return normalized
}

function resolveReferences(value: any, blobs: Map<string, unknown>): any {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, blobs))
  if (!value || typeof value !== 'object') return value
  if (typeof value.$ref === 'string' && blobs.has(value.$ref)) {
    return resolveReferences(blobs.get(value.$ref), blobs)
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveReferences(item, blobs)]),
  )
}

export function toTrainingExample(
  record: ArchiveRecord,
  signal?: { feedback: string | null; revertedAt: Date | null; hadError: boolean; truncated: boolean },
  blobs: Map<string, unknown> = new Map(),
  maxChars = MAX_EXAMPLE_CHARS,
): TrainingExample | null {
  if (!record.request || !record.response) return null
  const request = resolveReferences(record.request, blobs)
  const requestMessages = normalizeMessages(request)
  const response = record.response
  const responseOutput = Array.isArray(response.output) ? response.output : []
  const responseOutputText = responseOutput
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content || [])
    .map((part: any) => part?.text || '')
    .filter(Boolean)
    .join('')
  const responseFunctionCalls = responseOutput
    .filter((item: any) => item?.type === 'function_call')
    .map((item: any) => ({
      id: item.call_id || item.id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments || '{}' },
    }))
  const responseReasoning = responseOutput
    .filter((item: any) => item?.type === 'reasoning')
    .flatMap((item: any) => item.summary || [])
    .map((part: any) => part?.text || '')
    .filter(Boolean)
    .join('')
  const anthropicContent = Array.isArray(response.content) ? response.content : []
  const anthropicText = anthropicContent
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text || '')
    .filter(Boolean)
    .join('')
  const anthropicReasoning = anthropicContent
    .filter((part: any) => part?.type === 'thinking')
    .map((part: any) => part.thinking || '')
    .filter(Boolean)
    .join('')
  const anthropicToolCalls = anthropicContent
    .filter((part: any) => part?.type === 'tool_use')
    .map((part: any) => ({
      id: part.id,
      type: 'function',
      function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
    }))
  const assistant: any = {
    role: 'assistant',
    content: anthropicText || response.output_text || responseOutputText || (typeof response.content === 'string' ? response.content : null),
  }
  const reasoningContent = response.reasoning_content || anthropicReasoning || responseReasoning
  if (reasoningContent) assistant.reasoning_content = reasoningContent
  if (Array.isArray(response.reasoning_blocks) && response.reasoning_blocks.length > 0) {
    assistant.reasoning_blocks = response.reasoning_blocks
  } else if (anthropicContent.some((part: any) => part?.type === 'thinking' || part?.type === 'redacted_thinking')) {
    assistant.reasoning_blocks = anthropicContent.filter(
      (part: any) => part?.type === 'thinking' || part?.type === 'redacted_thinking',
    )
  }
  if (Array.isArray(response.reasoning_items) && response.reasoning_items.length > 0) {
    assistant.reasoning_items = response.reasoning_items
  } else {
    const responseReasoningItems = responseOutput.filter((item: any) => item?.type === 'reasoning')
    if (responseReasoningItems.length > 0) assistant.reasoning_items = responseReasoningItems
  }
  const toolCalls = [
    ...(Array.isArray(response.tool_calls) ? response.tool_calls : []),
    ...responseFunctionCalls,
    ...anthropicToolCalls,
  ]
  if (toolCalls.length > 0) {
    assistant.tool_calls = toolCalls.map((call: any) => ({
      id: call.id,
      type: call.type || 'function',
      function: call.function || { name: call.name, arguments: call.arguments || '{}' },
    }))
  }
  const scrubbed = scrubValue({
    messages: [...requestMessages, assistant],
    tools: request.tools,
  })
  if (scrubbed.secretFound) return null
  const mediaReferences = new Map<string, { hash: string; mime: string }>()
  collectMediaReferences(scrubbed.value.messages, mediaReferences)
  collectMediaReferences(scrubbed.value.tools, mediaReferences)
  const example: TrainingExample = {
    id: record.id,
    source: record.source || 'cloud_runtime',
    model: record.resolvedModel || record.requestedModel || null,
    ...(record.reasoningEffort ? { reasoning_effort: record.reasoningEffort } : {}),
    ...(scrubbed.value.tools ? { tools: scrubbed.value.tools } : {}),
    messages: scrubbed.value.messages,
    ...(mediaReferences.size ? {
      media: [...mediaReferences.values()].map(({ hash, mime }) => ({
        hash,
        mime,
        path: `media/${hash}`,
      })),
    } : {}),
    signals: {
      feedback: signal?.feedback ?? null,
      reverted: Boolean(signal?.revertedAt),
      hadError: Boolean(signal?.hadError || record.errorType),
      truncated: Boolean(signal?.truncated || record.truncated),
    },
  }
  if (JSON.stringify(example).length > maxChars) return null
  return example
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

interface ArchiveData {
  records: ArchiveRecord[]
  blobs: Map<string, unknown>
  media: Map<string, { mime: string; bytes: Uint8Array }>
}

function parseJsonLines(bytes: Uint8Array, key: string): ArchiveRecord[] {
  const compressed = key.endsWith('.gz')
  const text = (compressed ? gunzipSync(bytes) : Buffer.from(bytes)).toString('utf8')
  const records: ArchiveRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      console.warn(`[training-export] Skipping malformed line in ${key}`)
    }
  }
  return records
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

function mediaMime(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase()
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
  }[extension || ''] || 'application/octet-stream'
}

function collectMediaReferences(value: unknown, result: Map<string, { hash: string; mime: string }>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMediaReferences(item, result)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (typeof record.$media === 'string') {
    result.set(record.$media, {
      hash: record.$media,
      mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
    })
  }
  for (const item of Object.values(record)) collectMediaReferences(item, result)
}

async function readArchiveFiles(input: string): Promise<ArchiveData> {
  const files = input.startsWith('s3://')
    ? await readS3Files(input)
    : await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: input, absolute: true, onlyFiles: true }))
  const records: ArchiveRecord[] = []
  const blobs = new Map<string, unknown>()
  const media = new Map<string, { mime: string; bytes: Uint8Array }>()
  for (const file of files) {
    const key = typeof file === 'string'
      ? file.slice(input.length).replace(/^[/\\]+/, '')
      : file.key
    const data = typeof file === 'string' ? await Bun.file(file).arrayBuffer() : file.bytes
    const bytes = Buffer.from(data)
    if (key.endsWith('.jsonl') || key.endsWith('.jsonl.gz')) {
      records.push(...parseJsonLines(bytes, key))
    } else if (key.includes('/blobs/') && (key.endsWith('.json') || key.endsWith('.json.gz'))) {
      const blob = parseBlob(bytes)
      if (blob !== null) blobs.set(key, blob)
    } else if (key.includes('/media/')) {
      const hash = key.split('/').pop()?.split('.')[0]
      if (hash) media.set(hash, { mime: mediaMime(key), bytes })
    }
  }
  return { records, blobs, media }
}

async function readS3Files(uri: string): Promise<Array<{ key: string; bytes: Uint8Array }>> {
  const { S3Client, GetObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const parsed = new URL(uri)
  const bucket = parsed.hostname
  const prefix = parsed.pathname.replace(/^\/+/, '')
  const client = new S3Client({
    region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  })
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))
    keys.push(...(listed.Contents || [])
      .map((item: any) => item.Key)
      .filter((key: unknown): key is string =>
        typeof key === 'string' &&
        (key.endsWith('.jsonl') || key.endsWith('.jsonl.gz') || key.includes('/blobs/') || key.includes('/media/')),
      ))
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)
  return Promise.all(keys.map(async (key) => {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    return { key, bytes: await object.Body!.transformToByteArray() }
  }))
}

async function loadSignals(): Promise<Map<string, any>> {
  const { prisma } = await import('../../apps/api/src/lib/prisma')
  const rows = await (prisma as any).proxyTurn.findMany({
    select: { turnKey: true, feedback: true, revertedAt: true, hadError: true, truncated: true },
  })
  return new Map(rows.map((row: any) => [row.turnKey, row]))
}

async function loadConsent(): Promise<Map<string, boolean>> {
  const { prisma } = await import('../../apps/api/src/lib/prisma')
  const { getEffectivePlanId } = await import('../../apps/api/src/services/billing.service')
  const workspaces = await (prisma as any).workspace.findMany({
    select: { id: true, trainingDataMode: true },
  })
  const result = new Map<string, boolean>()
  for (const workspace of workspaces) {
    const plan = await getEffectivePlanId(workspace.id)
    result.set(workspace.id, workspace.trainingDataMode === 'enabled' ||
      (workspace.trainingDataMode === 'default' && plan !== 'enterprise'))
  }
  return result
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const input = String(args.input || process.env.S3_LLM_CAPTURES_BUCKET || '')
  if (!input) throw new Error('--input <archive-directory|s3://bucket/prefix> is required')
  const output = String(args.output || `exports/${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(output, { recursive: true })
  const archive = await readArchiveFiles(input)
  const records = archive.records
  const consent = await loadConsent()
  const signals = await loadSignals()
  const latest = new Map<string, ArchiveRecord>()
  for (const record of records) {
    if (!consent.get(record.workspaceId)) continue
    const previous = latest.get(record.turnKey)
    if (!previous || previous.ts < record.ts) latest.set(record.turnKey, record)
  }

  const seen = new Set<string>()
  const examples: TrainingExample[] = []
  const maxChars = Number(args['max-chars'] || MAX_EXAMPLE_CHARS)
  for (const record of latest.values()) {
    const signal = signals.get(record.turnKey)
    if (signal?.revertedAt || signal?.hadError || signal?.feedback === 'down' || record.truncated) continue
    if (args.provider && record.provider !== args.provider) continue
    if (args.model && record.resolvedModel !== args.model) continue
    const example = toTrainingExample(record, signal, archive.blobs, maxChars)
    if (!example) continue
    const dedupKey = stableHash({
      user: example.messages.find((message) => message.role === 'user')?.content,
      tools: example.tools,
    })
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    examples.push(example)
  }

  const mediaToWrite = new Map<string, string>()
  for (const example of examples) {
    for (const media of example.media || []) mediaToWrite.set(media.hash, media.path)
  }
  if (mediaToWrite.size) await mkdir(`${output}/media`, { recursive: true })
  for (const [hash, path] of mediaToWrite) {
    const asset = archive.media.get(hash)
    if (asset) await Bun.write(`${output}/${path}`, asset.bytes)
  }

  await Bun.write(`${output}/data.jsonl`, examples.map((example) => JSON.stringify(example)).join('\n') + (examples.length ? '\n' : ''))
  const parquetWritten = args.parquet !== 'false' && writeParquet(output, examples)
  await Bun.write(`${output}/manifest.json`, JSON.stringify({
    format: 'messages+tools',
    count: examples.length,
    files: {
      jsonl: 'data.jsonl',
      ...(parquetWritten ? { parquet: 'data.parquet' } : {}),
      ...(mediaToWrite.size ? { media: 'media/' } : {}),
    },
    input,
    filters: {
      provider: args.provider || null,
      model: args.model || null,
      maxChars,
      consent: true,
      quality: true,
    },
    createdAt: new Date().toISOString(),
  }, null, 2))
  console.log(`[training-export] Wrote ${examples.length} examples to ${output}`)
}

function writeParquet(output: string, examples: TrainingExample[]): boolean {
  const script = [
    'import json, sys',
    'import pyarrow as pa',
    'import pyarrow.parquet as pq',
    'rows = json.load(sys.stdin)',
    'columns = {',
    "  'id': [row['id'] for row in rows],",
    "  'source': [row['source'] for row in rows],",
    "  'model': [row.get('model') for row in rows],",
    "  'reasoning_effort': [row.get('reasoning_effort') for row in rows],",
    "  'messages': [json.dumps(row['messages'], separators=(',', ':')) for row in rows],",
    "  'tools': [json.dumps(row.get('tools', []), separators=(',', ':')) for row in rows],",
    "  'signals': [json.dumps(row['signals'], separators=(',', ':')) for row in rows],",
    '}',
    'pq.write_table(pa.table(columns), sys.argv[1])',
  ].join('\n')
  const result = spawnSync('python3', ['-c', script, `${output}/data.parquet`], {
    input: JSON.stringify(examples),
    encoding: 'utf8',
  })
  if (result.status === 0) return true
  console.warn(`[training-export] Parquet output skipped: ${result.stderr?.trim() || 'python3/pyarrow unavailable'}`)
  return false
}

if (import.meta.main) {
  await main()
}

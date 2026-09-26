import { PutObjectCommand } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { getLlmCaptureBucket, getS3Client } from '../s3'

const MAX_BUFFER_BYTES = 8 * 1024 * 1024
const FLUSH_INTERVAL_MS = 30_000

interface QueuedRecord {
  key: string
  line: string
  bytes: number
}

let queue: QueuedRecord[] = []
let queuedBytes = 0
let sequence = 0
let flushPromise: Promise<void> | null = null
let intervalStarted = false
const writtenBlobs = new Set<string>()
const writtenMedia = new Set<string>()
let droppedRecords = 0

function partition(now: Date): string {
  const region = process.env.REGION_ID || process.env.S3_REGION || process.env.AWS_REGION || 'unknown'
  const date = now.toISOString().slice(0, 10)
  const hour = now.toISOString().slice(11, 13)
  return `v1/region=${region}/date=${date}/hour=${hour}`
}

async function putObject(key: string, body: Buffer, contentType: string, contentEncoding?: string): Promise<void> {
  const bucket = getLlmCaptureBucket()
  await getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ...(contentEncoding ? { ContentEncoding: contentEncoding } : {}),
  }))
}

function startInterval(): void {
  if (intervalStarted) return
  intervalStarted = true
  const timer = setInterval(() => {
    void flushArchive()
  }, FLUSH_INTERVAL_MS)
  timer.unref?.()
}

export function enqueueBlob(key: string, value: unknown): void {
  if (writtenBlobs.has(key)) return
  writtenBlobs.add(key)
  void putObject(key, gzipSync(Buffer.from(JSON.stringify(value))), 'application/json', 'gzip').catch((error) => {
    writtenBlobs.delete(key)
    console.error('[ProxyCapture] Blob archive write failed:', error)
  })
}

export function enqueueMedia(hash: string, mime: string, bytes: Buffer): void {
  const key = `v1/media/${hash}`
  if (writtenMedia.has(key)) return
  writtenMedia.add(key)
  const extension = mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'bin'
  void putObject(`${key}.${extension}`, bytes, mime).catch((error) => {
    writtenMedia.delete(key)
    console.error('[ProxyCapture] Media archive write failed:', error)
  })
}

export function enqueueArchiveRecord(record: Record<string, unknown>, now = new Date()): void {
  startInterval()
  const line = `${JSON.stringify(record)}\n`
  const bytes = Buffer.byteLength(line)
  queue.push({ key: partition(now), line, bytes })
  queuedBytes += bytes
  while (queuedBytes > MAX_BUFFER_BYTES && queue.length > 1) {
    const dropped = queue.shift()!
    queuedBytes -= dropped.bytes
    droppedRecords += 1
    console.warn('[ProxyCapture] Archive buffer full; dropping oldest capture')
  }
  if (queuedBytes >= MAX_BUFFER_BYTES) void flushArchive()
}

export async function flushArchive(): Promise<void> {
  if (flushPromise || queue.length === 0) return flushPromise || Promise.resolve()
  const batch = queue
  queue = []
  queuedBytes = 0
  const grouped = new Map<string, string[]>()
  for (const item of batch) {
    const lines = grouped.get(item.key) || []
    lines.push(item.line)
    grouped.set(item.key, lines)
  }

  flushPromise = (async () => {
    try {
      await Promise.all([...grouped.entries()].map(([prefix, lines]) => {
        const key = `${prefix}/${process.env.HOSTNAME || 'api'}-${Date.now()}-${sequence++}.jsonl.gz`
        return putObject(key, gzipSync(Buffer.from(lines.join(''))), 'application/jsonl', 'gzip')
      }))
    } catch (error) {
      console.error('[ProxyCapture] Archive batch write failed:', error)
    } finally {
      flushPromise = null
      if (queue.length > 0) void flushArchive()
    }
  })()
  return flushPromise
}

export async function flushAndStopArchive(): Promise<void> {
  await flushArchive()
}

export function getArchiveWriterStats(): { queuedBytes: number; droppedRecords: number } {
  return { queuedBytes, droppedRecords }
}

import { PutObjectCommand } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { getLlmCaptureBucket, getLlmCaptureS3Client } from '../s3'

const FLUSH_AT_BYTES = 8 * 1024 * 1024
// Records keep arriving while a flush is uploading, so the drop threshold must
// sit well above the flush threshold or an in-flight upload forces drops.
const MAX_BUFFER_BYTES = Number(process.env.PROXY_CAPTURE_ARCHIVE_BUFFER_BYTES || 64 * 1024 * 1024)
const FLUSH_INTERVAL_MS = 30_000

interface QueuedRecord {
  key: string
  line: string
  bytes: number
}

export type ArchiveFormat = 'v1' | 'v2'

let queue: QueuedRecord[] = []
let queuedBytes = 0
let sequence = 0
let flushPromise: Promise<void> | null = null
let intervalStarted = false
// Blobs, media and chain nodes are content-addressed and shared across records,
// while the bucket lifecycle rule expires objects by last-modified age.
// Re-putting each referenced object once per UTC day keeps it younger than every
// record that points at it; the maps reset daily so they stay bounded. Each
// entry holds the in-flight PUT, so a second record referencing the same object
// waits for that upload instead of assuming it landed.
const writtenBlobs = new Map<string, Promise<void>>()
const writtenMedia = new Map<string, Promise<void>>()
const writtenChainNodes = new Map<string, Promise<void>>()
const pendingPersists = new Set<Promise<void>>()
let writtenDay = ''
let droppedRecords = 0

function resetDedupSetsDaily(): void {
  const day = new Date().toISOString().slice(0, 10)
  if (day === writtenDay) return
  writtenDay = day
  writtenBlobs.clear()
  writtenMedia.clear()
  writtenChainNodes.clear()
}

function partition(now: Date, format: ArchiveFormat): string {
  const region = process.env.REGION_ID || process.env.S3_REGION || process.env.AWS_REGION || 'unknown'
  const date = now.toISOString().slice(0, 10)
  const hour = now.toISOString().slice(11, 13)
  return `${format}/region=${region}/date=${date}/hour=${hour}`
}

async function putObject(key: string, body: Buffer, contentType: string, contentEncoding?: string): Promise<void> {
  const bucket = getLlmCaptureBucket()
  await getLlmCaptureS3Client().send(new PutObjectCommand({
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
  resetDedupSetsDaily()
  if (writtenBlobs.has(key)) return
  const put = putObject(key, gzipSync(Buffer.from(JSON.stringify(value))), 'application/json', 'gzip').catch((error) => {
    writtenBlobs.delete(key)
    console.error('[ProxyCapture] Blob archive write failed:', error)
  })
  writtenBlobs.set(key, put)
}

export function enqueueMedia(hash: string, mime: string, bytes: Buffer): void {
  const key = `v1/media/${hash}`
  resetDedupSetsDaily()
  if (writtenMedia.has(key)) return
  const extension = mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'bin'
  const put = putObject(`${key}.${extension}`, bytes, mime).catch((error) => {
    writtenMedia.delete(key)
    console.error('[ProxyCapture] Media archive write failed:', error)
  })
  writtenMedia.set(key, put)
}

// Chain nodes are the only archive objects a record depends on for its content,
// so this returns the shared in-flight PUT: a record that references a node
// another record started waits for that upload and sees its failure.
export function writeChainNode(key: string, body: unknown): Promise<void> {
  resetDedupSetsDaily()
  const existing = writtenChainNodes.get(key)
  if (existing) return existing
  const put = putObject(key, gzipSync(Buffer.from(JSON.stringify(body))), 'application/json', 'gzip')
    .catch((error) => {
      writtenChainNodes.delete(key)
      console.error('[ProxyCapture] Chain node archive write failed:', key, error)
      throw error
    })
  void put.catch(() => {})
  writtenChainNodes.set(key, put)
  return put
}

// Persists run after the response is sent, so shutdown has to wait for them
// before it drains the queue they feed.
export function trackPersist(promise: Promise<void>): void {
  pendingPersists.add(promise)
  const done = (): void => {
    pendingPersists.delete(promise)
  }
  void promise.then(done, done)
}

export function enqueueArchiveRecord(record: Record<string, unknown>, now = new Date(), format: ArchiveFormat = 'v1'): void {
  startInterval()
  const line = `${JSON.stringify(record)}\n`
  const bytes = Buffer.byteLength(line)
  queue.push({ key: partition(now, format), line, bytes })
  queuedBytes += bytes
  while (queuedBytes > MAX_BUFFER_BYTES && queue.length > 1) {
    const dropped = queue.shift()!
    queuedBytes -= dropped.bytes
    droppedRecords += 1
    console.warn('[ProxyCapture] Archive buffer full; dropping oldest capture')
  }
  if (queuedBytes >= FLUSH_AT_BYTES) void flushArchive()
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
  while (pendingPersists.size > 0) await Promise.allSettled([...pendingPersists])
  await flushArchive()
}

export function getArchiveWriterStats(): { queuedBytes: number; droppedRecords: number } {
  return { queuedBytes, droppedRecords }
}

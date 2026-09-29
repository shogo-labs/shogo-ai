import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { resetState, state } from './test-state'

class PutObjectCommand {
  constructor(public input: any) {}
}

let uploadGate: Promise<void> | null = null

mock.module('@aws-sdk/client-s3', () => ({ PutObjectCommand }))
mock.module('../../s3', () => ({
  getLlmCaptureBucket: () => 'capture-bucket',
  getLlmCaptureS3Client: () => ({
    send: async (command: any) => {
      if (uploadGate) await uploadGate
      if (state.fail) throw new Error('bucket unavailable')
      state.sends.push(command)
      return {}
    },
  }),
}))

const { enqueueArchiveRecord, enqueueBlob, flushArchive, getArchiveWriterStats } = await import('../archive-writer')

const MiB = 1024 * 1024
const hour = new Date('2026-09-26T05:00:00.000Z')

async function drain(): Promise<void> {
  for (let i = 0; i < 20 && (getArchiveWriterStats().queuedBytes > 0 || i < 2); i++) {
    await flushArchive()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function recordsIn(sends: any[]): string[] {
  return sends.flatMap((send) => gunzipSync(send.input.Body).toString().split('\n').filter(Boolean))
    .map((line) => JSON.parse(line).id)
}

beforeEach(() => {
  resetState()
})

afterEach(async () => {
  await flushArchive()
})

describe('proxy capture archive writer', () => {
  test('batches records as gzipped JSONL', async () => {
    enqueueArchiveRecord({ id: 'one', value: 1 }, new Date('2026-09-26T05:00:00.000Z'))
    enqueueArchiveRecord({ id: 'two', value: 2 }, new Date('2026-09-26T05:00:00.000Z'))
    await flushArchive()

    expect(state.sends).toHaveLength(1)
    expect(state.sends[0].input.Bucket).toBe('capture-bucket')
    expect(state.sends[0].input.ContentEncoding).toBe('gzip')
    expect(gunzipSync(state.sends[0].input.Body).toString()).toBe(
      '{"id":"one","value":1}\n{"id":"two","value":2}\n',
    )
  })

  test('isolates bucket failures from request handling', async () => {
    state.fail = true
    enqueueArchiveRecord({ id: 'unavailable' }, new Date('2026-09-26T05:00:00.000Z'))
    await expect(flushArchive()).resolves.toBeUndefined()
  })

  test('keeps buffering past the flush threshold while an upload is in flight', async () => {
    let release!: () => void
    uploadGate = new Promise((resolve) => { release = resolve })
    const droppedBefore = getArchiveWriterStats().droppedRecords
    try {
      const padding = 'x'.repeat(3 * MiB)
      for (let i = 0; i < 6; i++) enqueueArchiveRecord({ id: `in-flight-${i}`, padding }, hour)

      expect(getArchiveWriterStats().droppedRecords).toBe(droppedBefore)
      release()
      uploadGate = null
      await drain()
      expect(recordsIn(state.sends).sort()).toEqual([0, 1, 2, 3, 4, 5].map((i) => `in-flight-${i}`))
    } finally {
      uploadGate = null
      release()
    }
  })

  test('drops the oldest records only once the buffer cap is exceeded', async () => {
    let release!: () => void
    uploadGate = new Promise((resolve) => { release = resolve })
    const droppedBefore = getArchiveWriterStats().droppedRecords
    try {
      const padding = 'x'.repeat(4 * MiB)
      enqueueArchiveRecord({ id: 'first-batch', padding }, hour)
      enqueueArchiveRecord({ id: 'first-batch-2', padding }, hour)
      for (let i = 0; i < 18; i++) enqueueArchiveRecord({ id: `queued-${i}`, padding }, hour)

      expect(getArchiveWriterStats().droppedRecords - droppedBefore).toBe(3)
      expect(getArchiveWriterStats().queuedBytes).toBeLessThanOrEqual(64 * MiB)
      release()
      uploadGate = null
      await drain()
      const ids = recordsIn(state.sends)
      expect(ids).toContain('first-batch')
      expect(ids.filter((id) => /^queued-[012]$/.test(id))).toEqual([])
      expect(ids).toContain('queued-3')
      expect(ids).toContain('queued-17')
    } finally {
      uploadGate = null
      release()
    }
  })

  test('writes content-addressed blobs only once', async () => {
    enqueueBlob('v1/blobs/test.json.gz', { system: 'prompt' })
    enqueueBlob('v1/blobs/test.json.gz', { system: 'prompt' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.sends).toHaveLength(1)
    expect(state.sends[0].input.Key).toBe('v1/blobs/test.json.gz')
  })

  test('re-puts a referenced blob on a new UTC day so lifecycle expiry never orphans it', async () => {
    try {
      setSystemTime(new Date('2030-01-01T23:59:00.000Z'))
      enqueueBlob('v1/blobs/daily.json.gz', { system: 'prompt' })
      enqueueBlob('v1/blobs/daily.json.gz', { system: 'prompt' })
      setSystemTime(new Date('2030-01-02T00:01:00.000Z'))
      enqueueBlob('v1/blobs/daily.json.gz', { system: 'prompt' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(state.sends.filter((send) => send.input.Key === 'v1/blobs/daily.json.gz')).toHaveLength(2)
    } finally {
      setSystemTime()
    }
  })
})

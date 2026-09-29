import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { resetState, state } from './test-state'

class PutObjectCommand {
  constructor(public input: any) {}
}

mock.module('@aws-sdk/client-s3', () => ({ PutObjectCommand }))
mock.module('../../s3', () => ({
  getLlmCaptureBucket: () => 'capture-bucket',
  getS3Client: () => ({
    send: async (command: any) => {
      if (state.fail) throw new Error('bucket unavailable')
      state.sends.push(command)
      return {}
    },
  }),
}))

const { enqueueArchiveRecord, enqueueBlob, flushArchive } = await import('../archive-writer')

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

  test('writes content-addressed blobs only once', async () => {
    enqueueBlob('v1/blobs/test.json.gz', { system: 'prompt' })
    enqueueBlob('v1/blobs/test.json.gz', { system: 'prompt' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.sends).toHaveLength(1)
    expect(state.sends[0].input.Key).toBe('v1/blobs/test.json.gz')
  })
})

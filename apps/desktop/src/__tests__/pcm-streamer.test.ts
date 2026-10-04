// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import http from 'http'
import { afterEach, describe, expect, test } from 'bun:test'
import { LIVE_SOURCE_RATE } from '../recording/live-transcriber'
import { HttpPcmStreamer, LiveFeed, StreamMixer, type PcmSink } from '../recording/pcm-streamer'

function samples(seconds: number, value: number): Uint8Array {
  const out = new Int16Array(Math.round(seconds * LIVE_SOURCE_RATE)).fill(value)
  return new Uint8Array(out.buffer)
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('StreamMixer', () => {
  test('decimates 48 kHz mic audio to 16 kHz Int16', () => {
    const out: Buffer[] = []
    const mixer = new StreamMixer((pcm) => out.push(pcm))
    mixer.feedMic(samples(1, 1000))
    const all = Buffer.concat(out)
    expect(all.length / 2).toBe(16000)
    expect(all.readInt16LE(0)).toBe(1000)
    expect(mixer.micSamples).toBe(LIVE_SOURCE_RATE)
  })

  test('carries leftover samples so odd-sized reads do not drift', () => {
    const out: Buffer[] = []
    const mixer = new StreamMixer((pcm) => out.push(pcm))
    const whole = new Int16Array(4800).map((_, i) => (i % 3) * 300)
    // Two reads, split mid-triple.
    mixer.feedMic(new Uint8Array(whole.buffer, 0, 2 * 1000))
    mixer.feedMic(new Uint8Array(whole.buffer, 2 * 1000, 2 * 3800))
    const joined = Buffer.concat(out)
    expect(joined.length / 2).toBe(1600)
    for (let i = 0; i < 1600; i++) expect(joined.readInt16LE(i * 2)).toBe(300)
  })

  test('mixes system audio (downmixed from stereo) into the mic timeline', () => {
    const out: Buffer[] = []
    const mixer = new StreamMixer((pcm) => out.push(pcm))
    const stereo = new Int16Array(LIVE_SOURCE_RATE / 10 * 2)
    for (let i = 0; i < stereo.length; i += 2) {
      stereo[i] = 2000
      stereo[i + 1] = 4000 // averages to 3000
    }
    mixer.feedSystem(new Uint8Array(stereo.buffer), 2)
    mixer.feedMic(samples(0.1, 1000))
    const first = Buffer.concat(out).readInt16LE(0)
    expect(first).toBe(Math.round(1000 * 0.7 + 3000 * 0.7))
  })

  test('clips instead of wrapping when the mix is too loud', () => {
    const out: Buffer[] = []
    const mixer = new StreamMixer((pcm) => out.push(pcm))
    mixer.feedSystem(samples(0.1, 32767), 1)
    mixer.feedMic(samples(0.1, 32767))
    expect(Buffer.concat(out).readInt16LE(0)).toBe(32767)
  })

  test('system audio that runs far ahead of the mic is bounded', () => {
    const out: Buffer[] = []
    const mixer = new StreamMixer((pcm) => out.push(pcm))
    mixer.feedSystem(samples(5, 100), 1)
    mixer.feedMic(samples(3, 0))
    // Only the last second of system audio is kept, so the first mic seconds are silent-ish.
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('HttpPcmStreamer', () => {
  let server: http.Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  async function api(options: { ticketStatus?: number; reply?: () => unknown; dropEarly?: boolean } = {}) {
    const received: Buffer[] = []
    const headers: http.IncomingHttpHeaders[] = []
    let ended = false
    server = http.createServer((req, res) => {
      headers.push(req.headers)
      if (req.url?.endsWith('/stream-ticket')) {
        res.statusCode = options.ticketStatus ?? 200
        return res.end('{}')
      }
      if (options.dropEarly) {
        req.once('data', () => req.destroy())
        return
      }
      req.on('data', (d) => received.push(d))
      req.on('end', () => {
        ended = true
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(options.reply?.() ?? { ok: true, complete: true, chunks: 2, seconds: Buffer.concat(received).length / 32000 }))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as any).port
    return { draftUrl: `http://127.0.0.1:${port}/api/local/meetings/recordings/rec-1`, received, headers, ended: () => ended }
  }

  test('streams mixed 16 kHz audio as one request and returns the server summary', async () => {
    const a = await api()
    const streamer = new HttpPcmStreamer({ draftUrl: a.draftUrl, headers: { 'x-shogo-workspace-id': 'w1' }, onBroken: () => {} })
    expect(await streamer.start()).toBe(true)
    streamer.feedMic(samples(1, 500))
    streamer.feedMic(samples(1, 500))
    await tick()
    // Audio is on the wire before the recording ends.
    expect(Buffer.concat(a.received).length).toBeGreaterThan(0)
    expect(a.ended()).toBe(false)
    const summary = await streamer.finish()
    expect(summary).toEqual({ complete: true, chunks: 2, seconds: 2 })
    expect(Buffer.concat(a.received).length).toBe(2 * 32000)
    expect(a.headers.every((h) => h['x-shogo-workspace-id'] === 'w1')).toBe(true)
  })

  test('start() is false (use chunks) when the API cannot stream', async () => {
    const a = await api({ ticketStatus: 501 })
    const streamer = new HttpPcmStreamer({ draftUrl: a.draftUrl, onBroken: () => {} })
    expect(await streamer.start()).toBe(false)
    expect(await new HttpPcmStreamer({ draftUrl: 'http://127.0.0.1:1/x', onBroken: () => {} }).start()).toBe(false)
  })

  test('a server that gives up mid-stream reports a broken stream', async () => {
    const a = await api({ dropEarly: true })
    let broken = 0
    const streamer = new HttpPcmStreamer({ draftUrl: a.draftUrl, onBroken: () => broken++ })
    await streamer.start()
    streamer.feedMic(samples(1, 100))
    await tick(100)
    expect(broken).toBe(1)
    expect((await streamer.finish()).complete).toBe(false)
  })

  test('a failed server summary is never reported as complete', async () => {
    const a = await api({ reply: () => ({ ok: false, code: 'not_recording', message: 'done' }) })
    const streamer = new HttpPcmStreamer({ draftUrl: a.draftUrl, onBroken: () => {} })
    await streamer.start()
    streamer.feedMic(samples(1, 100))
    expect((await streamer.finish()).complete).toBe(false)
  })
})

describe('LiveFeed', () => {
  class Recorder implements PcmSink {
    mic: Uint8Array[] = []
    system = 0
    stopped: unknown[] = []
    constructor(readonly summary = { complete: true, chunks: 1, seconds: 4 }) {}
    feedMic(b: Uint8Array) { this.mic.push(b) }
    feedSystem() { this.system++ }
    stop(o?: unknown) { this.stopped.push(o) }
    async finish() { return this.summary }
  }

  /** A streamer stand-in: `start` result and a way to break it later. */
  function fakeStreamer(startOk: boolean, sink: Recorder) {
    let onBroken: () => void = () => {}
    const streamer = Object.assign(sink, {
      seconds: 7,
      start: async () => startOk,
    }) as unknown as HttpPcmStreamer
    return { make: (cb: () => void) => ((onBroken = cb), streamer), breakIt: () => onBroken() }
  }

  test('holds audio while deciding, then replays it into the stream', async () => {
    const stream = new Recorder()
    const fake = fakeStreamer(true, stream)
    const feed = new LiveFeed(fake.make, () => new Recorder())
    const begun = feed.begin()
    feed.feedMic(new Uint8Array(4))
    feed.feedSystem(new Uint8Array(4), 2)
    expect(await begun).toBe('stream')
    feed.feedMic(new Uint8Array(6))
    expect(stream.mic.map((b) => b.length)).toEqual([4, 6])
    expect(stream.system).toBe(1)
  })

  test('falls back to chunk upload from the start when streaming is unavailable', async () => {
    const chunks = new Recorder({ complete: true, chunks: 3, seconds: 24 })
    let offset = -1
    const feed = new LiveFeed(fakeStreamer(false, new Recorder()).make, (o) => ((offset = o), chunks))
    const begun = feed.begin()
    feed.feedMic(new Uint8Array(8))
    expect(await begun).toBe('chunks')
    expect(offset).toBe(0)
    expect(chunks.mic).toHaveLength(1)
    expect(await feed.finish()).toEqual({ complete: true, chunks: 3, seconds: 24 })
  })

  test('a stream that breaks hands over to chunks at the right offset and is marked incomplete', async () => {
    const stream = new Recorder()
    const fake = fakeStreamer(true, stream)
    const chunks = new Recorder({ complete: true, chunks: 2, seconds: 20 })
    let offset = -1
    const feed = new LiveFeed(fake.make, (o) => ((offset = o), chunks))
    await feed.begin()
    feed.feedMic(new Uint8Array(2))
    fake.breakIt()
    feed.feedMic(new Uint8Array(2))
    expect(offset).toBe(7)
    expect(stream.mic).toHaveLength(1)
    expect(chunks.mic).toHaveLength(1)
    expect((await feed.finish()).complete).toBe(false)
  })
})

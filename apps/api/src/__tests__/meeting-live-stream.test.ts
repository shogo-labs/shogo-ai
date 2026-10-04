// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live-transcript streaming relay: audio in, partial/final events out.
 * A fake recognizer stands in for OpenAI/sherpa; persistence and billing are
 * injected, so nothing here touches a database or the network.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../lib/prisma', () => ({ prisma: {} }))
mock.module('../lib/resolve-language-model', () => ({
  DEFAULT_ASSISTANT_MODEL: 'test-model',
  resolveLanguageModel: () => ({ model: { id: 'fake' } }),
}))
mock.module('../lib/ai-proxy-token', () => ({ generateProxyToken: async () => 'proxy-token' }))
mock.module('ai', () => ({ generateText: async () => ({ text: '' }) }))

const stream = await import('../services/meeting-live-stream')
const { createStreamTicket, verifyStreamTicket } = await import('../lib/meeting-stream-ticket')
const bus = await import('../lib/meeting-live-bus')

type BackendEvent = import('../services/meeting-live-stream').BackendEvent

const TICKET = { workspaceId: 'ws-1', userId: 'user-1', recordingId: 'rec-1', exp: Date.now() + 60_000 }

/** Emits a partial for every `partialEveryBytes` of audio and a final for the tail when flushed. */
class FakeBackend implements import('../services/meeting-live-stream').StreamingBackend {
  readonly name = 'sherpa' as const
  received = 0
  closed = false
  frames: Buffer[] = []
  private emit: (event: BackendEvent) => void = () => {}
  private item = 0
  private sinceFinal = 0

  constructor(
    readonly billed = false,
    private readonly options: { startDelayMs?: number; startError?: Error; partialEveryBytes?: number; finalEveryBytes?: number } = {},
  ) {}

  async start(emit: (event: BackendEvent) => void) {
    if (this.options.startDelayMs) await new Promise((r) => setTimeout(r, this.options.startDelayMs))
    if (this.options.startError) throw this.options.startError
    this.emit = emit
  }

  sendPcm(pcm: Buffer) {
    this.frames.push(pcm)
    this.received += pcm.byteLength
    this.sinceFinal += pcm.byteLength
    const secondsIn = this.received / 32000
    this.emit({ type: 'partial', itemId: `i${this.item}`, text: `words ${this.item}`, start: secondsIn })
    if (this.options.finalEveryBytes && this.sinceFinal >= this.options.finalEveryBytes) this.flushFinal()
  }

  private flushFinal() {
    const end = this.received / 32000
    this.emit({ type: 'final', itemId: `i${this.item}`, text: `segment ${this.item}`, start: end - this.sinceFinal / 32000, end })
    this.item++
    this.sinceFinal = 0
  }

  async finish() {
    if (this.sinceFinal > 0) this.flushFinal()
  }

  fail(message: string, fatal = true) {
    this.emit({ type: 'error', message, fatal })
  }

  close() {
    this.closed = true
  }
}

/** Feed `seconds` of audio in one-second frames (frames over the limit are rejected). */
function feed(session: { onAudio(frame: Buffer): void }, seconds: number) {
  for (let i = 0; i < seconds; i++) session.onAudio(pcm(1))
}

function harness(backend: FakeBackend, overrides: Partial<import('../services/meeting-live-stream').StreamSessionDeps> = {}) {
  const saved: Array<{ itemId: string; text: string; start: number; end: number }> = []
  const published: any[] = []
  const statuses: any[] = []
  const billed: number[] = []
  const deps: import('../services/meeting-live-stream').StreamSessionDeps = {
    ensureDraft: async () => ({ id: 'meeting-1', status: 'recording' }),
    appendFinal: async (_id, input) => {
      if (saved.some((s) => s.itemId === input.itemId)) return { ok: true, stored: false, finals: saved.length }
      saved.push({ itemId: input.itemId, ...input.segment })
      return { ok: true, stored: true, finals: saved.length }
    },
    publish: (_id, event) => published.push(event),
    setStatus: async (_id, status) => {
      statuses.push(status)
    },
    bill: async (_ticket, seconds) => {
      billed.push(seconds)
    },
    admit: async () => true,
    ...overrides,
  }
  const choice = { name: backend.name, create: () => backend }
  const sent: any[] = []
  const session = new stream.LiveStreamSession(TICKET, 0, (m) => sent.push(m), choice, deps)
  return { session, sent, saved, published, statuses, billed, deps, choice }
}

/** 16 kHz mono PCM16, one second of a 440 Hz tone. */
function pcm(seconds: number): Buffer {
  const samples = Math.round(seconds * 16000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000), i * 2)
  return buf
}

describe('Upsampler16to24', () => {
  test('produces 3 samples for every 2 and keeps a flat signal flat', () => {
    const up = new stream.Upsampler16to24()
    const out = up.process(new Int16Array(1600).fill(1000))
    expect(Math.abs(out.length - 2400)).toBeLessThanOrEqual(1)
    expect(Array.from(out.slice(5))).toEqual(new Array(out.length - 5).fill(1000))
  })

  test('chunk boundaries do not drop or duplicate samples', () => {
    const input = new Int16Array(3200).map((_, i) => Math.round(Math.sin(i / 20) * 5000))
    const whole = new stream.Upsampler16to24().process(input)
    const split = new stream.Upsampler16to24()
    const parts = [split.process(input.slice(0, 1111)), split.process(input.slice(1111, 2000)), split.process(input.slice(2000))]
    const joined = Int16Array.from(parts.flatMap((p) => Array.from(p)))
    expect(joined.length).toBe(whole.length)
    expect(Array.from(joined)).toEqual(Array.from(whole))
  })
})

describe('prettifyAsr', () => {
  test('sentence-cases shouting recognizer output and leaves normal text alone', () => {
    expect(stream.prettifyAsr('HELLO THERE EVERYONE')).toBe('Hello there everyone')
    expect(stream.prettifyAsr('  already Fine  ')).toBe('Already Fine')
    expect(stream.prettifyAsr('   ')).toBe('')
  })
})

describe('stream tickets', () => {
  test('round trip, tampering and expiry', () => {
    const ticket = createStreamTicket({ workspaceId: 'ws-1', userId: 'u', recordingId: 'rec' })
    expect(verifyStreamTicket(ticket)).toMatchObject({ workspaceId: 'ws-1', userId: 'u', recordingId: 'rec' })
    const [payload, sig] = ticket.split('.')
    const forged = Buffer.from(JSON.stringify({ workspaceId: 'ws-other', userId: 'u', recordingId: 'rec', exp: Date.now() + 1e6 })).toString('base64url')
    expect(verifyStreamTicket(`${forged}.${sig}`)).toBeNull()
    expect(verifyStreamTicket(`${payload}.${'0'.repeat(sig.length)}`)).toBeNull()
    expect(verifyStreamTicket('garbage')).toBeNull()
    expect(verifyStreamTicket(null)).toBeNull()
    const old = createStreamTicket({ workspaceId: 'ws-1', userId: null, recordingId: 'rec' }, 1000, 5000)
    expect(verifyStreamTicket(old, 7000)).toBeNull()
    expect(verifyStreamTicket(old, 3000)?.userId).toBeNull()
  })

  test('socket data rejects a bad ticket and clamps the offset', () => {
    expect(stream.meetingStreamSocketData(new URL('http://x/api/meetings/live-stream?ticket=nope'))).toBeNull()
    const ticket = createStreamTicket({ workspaceId: 'ws-1', userId: 'u', recordingId: 'rec' })
    const url = (offset: string) => new URL(`http://x/api/meetings/live-stream?ticket=${ticket}&offset=${offset}`)
    expect(stream.meetingStreamSocketData(url('42'))?.offsetSeconds).toBe(42)
    expect(stream.meetingStreamSocketData(url('-3'))?.offsetSeconds).toBe(0)
    expect(stream.meetingStreamSocketData(url('abc'))?.offsetSeconds).toBe(0)
  })
})

describe('LiveStreamSession', () => {
  test('partials reach the recorder and the bus immediately; finals are saved then published', async () => {
    const backend = new FakeBackend(false, { finalEveryBytes: 32000 })
    const h = harness(backend)
    expect(await h.session.begin()).toBe(true)
    expect(h.sent[0]).toEqual({ type: 'ready', backend: 'sherpa' })

    h.session.onAudio(pcm(0.5))
    expect(h.sent.at(-1)).toMatchObject({ type: 'partial', text: 'words 0' })
    expect(h.published.at(-1)).toMatchObject({ type: 'partial' })
    expect(h.saved).toHaveLength(0)

    h.session.onAudio(pcm(0.5))
    await h.session.finish()
    expect(h.saved.map((s) => s.itemId)).toEqual(['i0'])
    expect(h.published.some((e) => e.type === 'final' && e.itemId === 'i0')).toBe(true)
    expect(h.sent.at(-1)).toEqual({ type: 'done', complete: true, chunks: 1, seconds: 1 })
    expect(backend.closed).toBe(true)
  })

  test('audio sent while the recognizer starts is held and replayed in order', async () => {
    const backend = new FakeBackend(false, { startDelayMs: 30 })
    const h = harness(backend)
    const begun = h.session.begin()
    const a = pcm(0.1)
    const b = pcm(0.2)
    h.session.onAudio(a)
    h.session.onAudio(b)
    await begun
    expect(backend.frames).toEqual([a, b])
  })

  test('offset seconds are included in the reported coverage', async () => {
    const backend = new FakeBackend()
    const h = harness(backend)
    const session = new stream.LiveStreamSession(TICKET, 10, (m) => h.sent.push(m), h.choice, h.deps)
    await session.begin()
    feed(session, 2)
    await session.finish()
    expect(h.sent.at(-1)).toMatchObject({ type: 'done', seconds: 12 })
  })

  test('bills streamed seconds once, and only for the billed backend', async () => {
    const billedRun = harness(new FakeBackend(true))
    await billedRun.session.begin()
    feed(billedRun.session, 3)
    await billedRun.session.finish()
    billedRun.session.close()
    expect(billedRun.billed).toEqual([3])

    const freeRun = harness(new FakeBackend(false))
    await freeRun.session.begin()
    feed(freeRun.session, 3)
    await freeRun.session.finish()
    expect(freeRun.billed).toEqual([])
  })

  test('a workspace out of credits is refused before any recognizer starts', async () => {
    const backend = new FakeBackend(true)
    const h = harness(backend, { admit: async () => false })
    expect(await h.session.begin()).toBe(false)
    expect(h.sent[0]).toMatchObject({ type: 'error', code: 'usage_limit_reached', fatal: true })
    expect(backend.frames).toHaveLength(0)
  })

  test('a recording that already finished is not streamed into', async () => {
    const h = harness(new FakeBackend(), { ensureDraft: async () => ({ id: 'meeting-1', status: 'ready' }) })
    expect(await h.session.begin()).toBe(false)
    expect(h.sent[0]).toMatchObject({ type: 'error', code: 'not_recording' })
  })

  test('no recognizer available is reported so the recorder falls back to chunks', async () => {
    const sent: any[] = []
    const session = new stream.LiveStreamSession(TICKET, 0, (m) => sent.push(m), null, harness(new FakeBackend()).deps)
    expect(await session.begin()).toBe(false)
    expect(sent[0]).toMatchObject({ type: 'error', code: 'stream_unavailable', fatal: true })
  })

  test('a recognizer that fails to start surfaces on the draft', async () => {
    const h = harness(new FakeBackend(false, { startError: new Error('boom') }))
    expect(await h.session.begin()).toBe(false)
    expect(h.sent.at(-1)).toMatchObject({ type: 'error', code: 'backend_unavailable', fatal: true })
    expect(h.statuses.at(-1)?.state).toBe('error')
  })

  test('a mid-stream recognizer error marks the stream incomplete and records the reason', async () => {
    const backend = new FakeBackend()
    const h = harness(backend)
    await h.session.begin()
    h.session.onAudio(pcm(1))
    backend.fail('upstream closed', false)
    await h.session.finish()
    expect(h.statuses.at(-1)?.state).toBe('error')
    expect(h.sent.at(-1)).toMatchObject({ type: 'done', complete: false })
  })

  test('a duplicated final is saved once', async () => {
    const backend = new FakeBackend(false, { finalEveryBytes: 100 })
    const h = harness(backend)
    await h.session.begin()
    h.session.onAudio(pcm(0.1))
    await h.session.finish()
    expect(h.saved).toHaveLength(1)
    expect(h.sent.filter((m) => m.type === 'final')).toHaveLength(1)
  })

  test('oversize frames are ignored', async () => {
    const backend = new FakeBackend()
    const h = harness(backend)
    await h.session.begin()
    h.session.onAudio(Buffer.alloc(stream.STREAM_MAX_FRAME_BYTES + 2))
    expect(backend.frames).toHaveLength(0)
  })
})

describe('meeting live bus', () => {
  beforeEach(async () => {
    await bus._resetMeetingLiveBusForTests(null)
  })

  test('delivers to subscribers of that meeting only, and stops after unsubscribe', () => {
    const a: any[] = []
    const b: any[] = []
    const offA = bus.subscribeMeetingLive('m-a', (e) => a.push(e))
    bus.subscribeMeetingLive('m-b', (e) => b.push(e))
    bus.publishMeetingLive('m-a', { type: 'status', state: 'ok' } as any)
    offA()
    bus.publishMeetingLive('m-a', { type: 'status', state: 'error', message: 'x' } as any)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })

  test('with Redis, events are published to the shared channel', async () => {
    const published: Array<[string, string]> = []
    await bus._resetMeetingLiveBusForTests({ publish: async (channel: string, payload: string) => (published.push([channel, payload]), 1) } as any)
    bus.publishMeetingLive('m-r', { type: 'status', state: 'ok' } as any)
    await new Promise((r) => setTimeout(r, 10))
    expect(published[0]?.[0]).toBe('meeting:live:m-r')
    expect(JSON.parse(published[0][1])).toMatchObject({ meetingId: 'm-r', event: { type: 'status', state: 'ok' } })
  })
})

describe('runHttpAudioStream (WAV fixture, end to end)', () => {
  /** A real WAV file's samples, as the desktop recorder would stream them. */
  function wavFixture(seconds: number): { wav: Buffer; pcm: Buffer } {
    const data = pcm(seconds)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVEfmt ', 8, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24)
    header.writeUInt32LE(32000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(data.length, 40)
    return { wav: Buffer.concat([header, data]), pcm: data }
  }

  test('words reach the live viewers while the recording is still going, and the final summary covers it all', async () => {
    const { wav } = wavFixture(3)
    const samples = wav.subarray(44)
    const backend = new FakeBackend(false, { finalEveryBytes: 32000 })
    const h = harness(backend)

    const viewer: any[] = []
    const events: string[] = []
    await bus._resetMeetingLiveBusForTests(null)
    const offViewer = bus.subscribeMeetingLive('meeting-1', (e) => viewer.push(e))

    // The publish dep from the harness is what the viewer hears; route it through the bus.
    const deps = { ...h.deps, publish: bus.publishMeetingLive }
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let sentBytes = 0
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // 100 ms frames, deliberately split on odd byte boundaries.
        const frame = 3203
        for (let offset = 0; offset < samples.length - 32000; offset += frame) {
          controller.enqueue(new Uint8Array(samples.subarray(offset, Math.min(offset + frame, samples.length - 32000))))
          sentBytes = Math.min(offset + frame, samples.length - 32000)
          await new Promise((r) => setTimeout(r, 1))
        }
        events.push(`viewer-saw-partial:${viewer.some((e) => e.type === 'partial')}`)
        await held
        controller.enqueue(new Uint8Array(samples.subarray(samples.length - 32000)))
        controller.close()
      },
    })

    const outcomePromise = stream.runHttpAudioStream(body, TICKET, { choice: h.choice, deps })
    // Wait until the first two seconds are in but the last second is still being held back.
    for (let i = 0; i < 200 && !events.length; i++) await new Promise((r) => setTimeout(r, 5))
    expect(sentBytes).toBeGreaterThan(0)
    expect(events[0]).toBe('viewer-saw-partial:true')
    expect(viewer.some((e) => e.type === 'final')).toBe(true)
    release()

    const outcome = await outcomePromise
    offViewer()
    expect(outcome).toEqual({ ok: true, complete: true, chunks: h.saved.length, seconds: 3 })
    expect(h.saved.length).toBeGreaterThanOrEqual(2)
    expect(h.saved.map((s) => s.text)).toEqual(h.saved.map((_, i) => `segment ${i}`))
    // Odd split points must not shift samples: the recognizer heard exactly the file's audio.
    expect(Buffer.concat(backend.frames).equals(samples)).toBe(true)
  })

  test('reports why it could not start, with no audio consumed', async () => {
    const h = harness(new FakeBackend(), { admit: async () => false })
    const outcome = await stream.runHttpAudioStream(new ReadableStream({ start: (c) => c.close() }), TICKET, {
      choice: h.choice,
      deps: h.deps,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'usage_limit_reached' })
    expect(await stream.runHttpAudioStream(null, TICKET, { choice: h.choice, deps: harness(new FakeBackend()).deps })).toMatchObject({
      ok: false,
      code: 'empty',
    })
  })

  test('a recorder that disconnects mid-stream still keeps what was transcribed', async () => {
    const backend = new FakeBackend(false, { finalEveryBytes: 32000 })
    const h = harness(backend)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(pcm(1.5)))
      },
      pull(controller) {
        controller.error(new Error('socket hang up'))
      },
    })
    const outcome = await stream.runHttpAudioStream(body, TICKET, { choice: h.choice, deps: h.deps })
    expect(outcome.ok).toBe(true)
    expect(h.saved.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Recognizer backends, driven through fake sockets (protocol-level checks; the
// real services are exercised by the scripts under /tmp, not by unit tests).
// ---------------------------------------------------------------------------

class FakeSocket {
  sent: Array<string | Uint8Array> = []
  onopen: any = null
  onmessage: any = null
  onclose: any = null
  onerror: any = null
  send(d: any) { this.sent.push(d) }
  close() {}
  json() { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s)) }
  receive(obj: unknown) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }) }
}

/** 16 kHz PCM16 of constant amplitude, `ms` long. */
function tone(ms: number, amplitude: number): Buffer {
  const samples = new Int16Array((16000 * ms) / 1000).fill(amplitude)
  return Buffer.from(samples.buffer)
}

async function openAiBackend() {
  const socket = new FakeSocket()
  const backend = new stream.OpenAIRealtimeBackend('sk-test', false, 0, () => socket as any)
  const events: BackendEvent[] = []
  const started = backend.start((e) => events.push(e))
  socket.onopen()
  await started
  return { backend, socket, events }
}

describe('OpenAIRealtimeBackend', () => {
  test('configures a GA transcription session (no beta header, 24 kHz pcm, server VAD)', async () => {
    const { socket } = await openAiBackend()
    const update = socket.json()[0]
    expect(update.type).toBe('session.update')
    expect(update.session.type).toBe('transcription')
    expect(update.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 })
    expect(update.session.audio.input.transcription.model).toBe(stream.OPENAI_TRANSCRIBE_MODEL)
    expect(update.session.audio.input.turn_detection.type).toBe('server_vad')
  })

  test('forces a commit after the maximum utterance when the speaker never pauses', async () => {
    const { backend, socket } = await openAiBackend()
    for (let i = 0; i < 10; i++) backend.sendPcm(tone(1000, 5000)) // 10 s of unbroken loud audio
    const commits = socket.json().filter((m) => m.type === 'input_audio_buffer.commit')
    expect(commits.length).toBe(1)
  })

  test('cuts at a pause once past the preferred length, not in the middle of a word', async () => {
    const { backend, socket } = await openAiBackend()
    backend.sendPcm(tone(2000, 5000))
    expect(socket.json().filter((m) => m.type === 'input_audio_buffer.commit').length).toBe(0)
    backend.sendPcm(tone(1500, 5000)) // 3.5 s of speech, still no dip
    expect(socket.json().filter((m) => m.type === 'input_audio_buffer.commit').length).toBe(0)
    backend.sendPcm(tone(100, 0)) // a 100 ms dip is a closed-lips moment inside a word: keep going
    expect(socket.json().filter((m) => m.type === 'input_audio_buffer.commit').length).toBe(0)
    backend.sendPcm(tone(200, 0)) // a real pause
    expect(socket.json().filter((m) => m.type === 'input_audio_buffer.commit').length).toBe(1)
  })

  test('does not commit during silence', async () => {
    const { backend, socket } = await openAiBackend()
    for (let i = 0; i < 20; i++) backend.sendPcm(tone(1000, 0))
    expect(socket.json().filter((m) => m.type === 'input_audio_buffer.commit').length).toBe(0)
  })

  test('streams deltas as partials then a final with the forced commit boundaries', async () => {
    const { backend, socket, events } = await openAiBackend()
    backend.sendPcm(tone(3500, 5000))
    backend.sendPcm(tone(300, 0)) // forced commit at ~3.5 s
    socket.receive({ type: 'input_audio_buffer.committed', item_id: 'i1' })
    socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'hello ' })
    socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'there' })
    socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hello there' })
    const partials = events.filter((e) => e.type === 'partial')
    const final = events.find((e) => e.type === 'final') as any
    expect(partials.length).toBe(2)
    expect(final.text).toBe('Hello there')
    expect(final.start).toBe(0)
    expect(final.end).toBeGreaterThan(3)
    expect(final.end).toBeLessThan(4)
  })

  test('an empty-commit error at the end is ignored, other errors are surfaced as non-fatal', async () => {
    const { socket, events } = await openAiBackend()
    socket.receive({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'empty' } })
    expect(events.length).toBe(0)
    socket.receive({ type: 'error', error: { code: 'x', message: 'boom' } })
    expect(events).toEqual([{ type: 'error', message: 'boom', fatal: false }])
  })
})

describe('SherpaOnlineBackend', () => {
  const sherpaReply = (text: string, segment: number, isFinal = false) =>
    JSON.stringify({ text, segment, is_final: isFinal, start_time: segment * 10 })

  test('"Done!" finalizes the segment still open (the recognizer never closes the socket)', () => {
    const backend: any = new stream.SherpaOnlineBackend(0, () => new FakeSocket() as any)
    const events: BackendEvent[] = []
    backend.emit = (e: BackendEvent) => events.push(e)
    backend.onMessage(sherpaReply(' THE CHURN NUMBERS', 1))
    backend.onMessage(sherpaReply(' THE CHURN NUMBERS AT OUR NEXT MEETING', 1))
    expect(events.map((e) => e.type)).toEqual(['partial', 'partial'])
    backend.onMessage('Done!')
    const final = events[2] as any
    expect(final.type).toBe('final')
    expect(final.text).toBe('The churn numbers at our next meeting')
    expect(final.itemId).toBe('sherpa-0-1')
    expect(backend.done).toBe(true)
  })

  test('an endpointed segment is final once, and "Done!" does not repeat it', () => {
    const backend: any = new stream.SherpaOnlineBackend(0, () => new FakeSocket() as any)
    const events: BackendEvent[] = []
    backend.emit = (e: BackendEvent) => events.push(e)
    backend.onMessage(sherpaReply(' HELLO', 0))
    backend.onMessage(sherpaReply(' HELLO WORLD', 0, true))
    backend.onMessage('Done!')
    expect(events.filter((e) => e.type === 'final').length).toBe(1)
  })

  test('a refused connection attempt while the server is binding is not "finished"', async () => {
    const sockets: FakeSocket[] = []
    const backend: any = new stream.SherpaOnlineBackend(0, () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s as any
    })
    const refused = backend.connect(1234)
    sockets[0].onerror()
    sockets[0].onclose()
    await expect(refused).rejects.toThrow()
    expect(backend.done).toBe(false)

    const ok = backend.connect(1234)
    sockets[1].onopen()
    await ok
    sockets[1].onclose() // a genuine close after being connected
    expect(backend.done).toBe(true)
  })
})

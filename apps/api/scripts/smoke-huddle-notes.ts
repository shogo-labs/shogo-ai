// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The notes worker's audio path against a real LiveKit server, because it is
 * the one part of the fallback unit tests cannot reach: a real remote track,
 * resampled to 16 kHz, feeding the STT stream, and the three ways a stream has
 * to stop (the call's notes toggle in the room metadata, the huddle row, and an
 * empty wallet on a meter flush).
 *
 *     brew install livekit && bun run smoke:huddle-notes
 *     bun run smoke:huddle-notes -- --mode=row      # stop via the huddle row
 *     bun run smoke:huddle-notes -- --mode=balance  # stop via the wallet (60s)
 *
 * Needs `livekit-server` on PATH (skipped otherwise) and no cloud credentials:
 * real transcription needs LiveKit Cloud Inference, so this exercises the
 * frames, the delay, the metering and the stops with a stub STT stream.
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackSource } from '@livekit/rtc-node'
import { runNotesJob } from '../src/workers/huddle-notes-agent'

const KEY = 'devkey'
const SECRET = 'secret'
const HTTP = 'http://127.0.0.1:7880'
const WS = 'ws://127.0.0.1:7880'
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'metadata'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

if (!Bun.which('livekit-server')) {
  console.log('skipped: livekit-server is not on PATH (brew install livekit)')
  process.exit(0)
}

const server = Bun.spawn(['livekit-server', '--dev'], { stdout: 'ignore', stderr: 'ignore' })
let up = false
for (let attempt = 0; attempt < 60 && !up; attempt++) {
  up = await fetch(`${HTTP}/`).then(() => true).catch(() => false)
  if (!up) await sleep(250)
}
if (!up) {
  server.kill()
  throw new Error('livekit-server did not start')
}

const roomName = `smoke-notes-${Date.now()}`
const token = async (identity: string) => {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: 600 })
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })
  return at.toJwt()
}

const speaker = new Room()
const worker = new Room()
const seen: string[] = []
const metered: Array<{ identity: string; seconds: number }> = []
const notesOff: Array<{ reason: string; message: string }> = []
const stats = { pushed: 0, streamEnded: 0 }
let rowSaysNotesOn = true
let walletHasCredit = true
let ended = false
let pumping = true
let source: AudioSource | null = null

try {
  await speaker.connect(WS, await token('alice'))
  source = new AudioSource(48_000, 1)
  const track = LocalAudioTrack.createAudioTrack('mic', source)
  await speaker.localParticipant.publishTrack(track, { source: TrackSource.MICROPHONE })

  const frame = AudioFrame.create(48_000, 1, 480)
  let sample = 0
  void (async () => {
    while (pumping) {
      for (let i = 0; i < frame.samplesPerChannel; i++) {
        frame.data[i] = Math.round(8000 * Math.sin(((sample++ * 2 * Math.PI * 440) / 48_000) | 0))
      }
      await source!.captureFrame(frame).catch(() => {})
      await sleep(10)
    }
  })()

  await worker.connect(WS, await token('probe'))
  await sleep(1_500)
  seen.push(...[...worker.remoteParticipants.values()].map((participant) => participant.identity))

  const stubStt = () => {
    const engine: any = {
      pushFrame: () => void stats.pushed++,
      endInput: () => void stats.streamEnded++,
      [Symbol.asyncIterator]: async function* () {
        await new Promise(() => {})
      },
    }
    engine.stream = () => engine
    return engine
  }

  const job = runNotesJob({
    huddleId: 'huddle-smoke',
    room: worker as any,
    sttFor: stubStt as any,
    deps: {
      appendFinal: async () => {},
      meteredSeconds: async (input) => void metered.push({ identity: input.identity, seconds: input.seconds }),
      notesEnabled: async () => rowSaysNotesOn,
      balanceOk: async () => walletHasCredit,
      notesOff: async (_huddleId, reason, message) => void notesOff.push({ reason, message }),
      startedAt: async () => Date.now(),
    },
  }).then(() => (ended = true))

  // The fallback waits FALLBACK_DELAY_MS (5s) before it covers a track.
  await sleep(8_000)
  const covered = stats.pushed > 0
  const pushed = stats.pushed

  if (mode === 'row') rowSaysNotesOn = false
  else if (mode === 'balance') {
    // Seconds flush, and the balance is checked, every 60s.
    await sleep(54_000)
    walletHasCredit = false
  } else {
    await new RoomServiceClient(HTTP, KEY, SECRET).updateRoomMetadata(
      roomName,
      JSON.stringify({ huddleId: 'huddle-smoke', notes: false }),
    )
  }

  // A row toggle is noticed on the next tick (NOTES_COVERAGE_TICK_MS).
  if (mode === 'row') await sleep(1_800)
  const pushedWhenStopped = stats.pushed
  await sleep(mode === 'balance' ? 12_000 : 2_500)
  await job

  const stoppedOnWallet = notesOff.some((entry) => entry.reason === 'usage_limit_reached')
  const result = {
    mode,
    covered,
    framesPushed: pushed,
    stopped: ended,
    quietAfterStop: mode === 'balance' ? undefined : stats.pushed === pushedWhenStopped,
    metered,
    notesOff,
    streamsClosed: stats.streamEnded,
    sawSpeaker: seen.includes('alice'),
  }
  const ok =
    result.covered &&
    result.stopped &&
    result.sawSpeaker &&
    (mode === 'balance' ? stoppedOnWallet && metered.some((entry) => entry.seconds >= 60) : result.quietAfterStop === true)
  console.log(JSON.stringify({ ok, ...result }, null, 2))
  process.exitCode = ok ? 0 : 1
} finally {
  pumping = false
  await sleep(100)
  await speaker.disconnect().catch(() => {})
  await worker.disconnect().catch(() => {})
  server.kill()
  // rtc-node keeps the Bun event loop alive after every room is closed.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250)
}

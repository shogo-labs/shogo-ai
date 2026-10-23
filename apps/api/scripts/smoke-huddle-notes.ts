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
 *     bun run smoke:huddle-notes -- --mode=dispatch # the worker itself: register,
 *                                                   # dispatch, job, no second job
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

if (mode === 'dispatch') {
  const code = await runDispatchSmoke().catch((err) => {
    console.error(err)
    return 1
  })
  server.kill()
  process.exit(code)
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

/**
 * The part unit tests cannot see: that the API host can start the worker
 * in-process at all, and that a dispatch really spawns a job here. It boots the
 * worker exactly as `server.ts` does, dispatches against a real room, and fails
 * unless a `huddle-notes` participant (or a running job) appears — then checks a
 * second dispatch does not mint a second job.
 */
async function runDispatchSmoke(): Promise<number> {
  process.env.LIVEKIT_URL = WS
  process.env.LIVEKIT_API_KEY = KEY
  process.env.LIVEKIT_API_SECRET = SECRET
  const { NOTES_AGENT_ATTRIBUTE, dispatchNotesAgent } = await import('../src/lib/livekit-notes')
  const { isNotesAgent } = await import('../src/services/huddle-notes-coverage')
  const { startNotesWorker } = await import('../src/workers/huddle-notes-agent')

  const agent = await startNotesWorker()
  if (!agent) {
    console.log(JSON.stringify({ ok: false, mode, reason: 'the worker did not register with LiveKit' }, null, 2))
    return 1
  }

  const rooms = new RoomServiceClient(HTTP, KEY, SECRET)
  const huddleId = 'huddle-dispatch-smoke'
  const caller = new Room()
  const step = (name: string) => console.log(`[dispatch] ${name}`)
  try {
    step('room')
    await rooms.createRoom({ name: roomName, metadata: JSON.stringify({ huddleId, notes: true }) })
    step('caller')
    await caller.connect(WS, await token('alice'))
    step('dispatch')
    const first = await dispatchNotesAgent(roomName, huddleId)
    step(`dispatched: ${JSON.stringify(first)}`)

    let sawJob = false
    let sawAgent = false
    for (let attempt = 0; attempt < 240 && !sawAgent; attempt++) {
      if (agent.activeJobs.length > 0) sawJob = true
      const participants = await rooms.listParticipants(roomName).catch(() => [])
      sawAgent = participants.some(
        (participant: any) =>
          participant?.attributes?.[NOTES_AGENT_ATTRIBUTE] === '1' || isNotesAgent(String(participant?.identity ?? '')),
      )
      if (!sawAgent) await sleep(50)
    }

    // A second dispatch while an agent is already there must not add a job:
    // each job transcribes and bills the same tracks.
    const jobsBefore = agent.activeJobs.length
    const second = await dispatchNotesAgent(roomName, huddleId)
    await sleep(1_500)
    const jobsAfter = agent.activeJobs.length

    // The room has no huddle row, so the job itself ends early — this asserts
    // the plumbing that has to work before the job can do anything.
    const result = {
      mode,
      registered: Boolean(agent.id),
      firstDispatch: first,
      secondDispatch: second,
      sawAgent,
      sawJob,
      jobsBefore,
      jobsAfter,
    }
    const ok = first.ok && (sawAgent || sawJob) && second.ok && jobsAfter <= Math.max(jobsBefore, 1)
    console.log(JSON.stringify({ ok, ...result }, null, 2))
    return ok ? 0 : 1
  } finally {
    await caller.disconnect().catch(() => {})
    await rooms.deleteRoom(roomName).catch(() => {})
    await agent.close().catch(() => {})
  }
}

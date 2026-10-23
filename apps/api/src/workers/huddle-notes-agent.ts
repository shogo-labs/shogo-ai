// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The hidden `huddle-notes` fallback agent.
 *
 * Every participant's own device already transcribes their mic through the
 * meeting pipeline; a web/desktop coverer picks up native-app participants.
 * This worker exists for the tracks nobody covers: an all-native call, a
 * coverer who left, or a client whose stream failed. It joins silently with
 * subscriptions only, and opens an Inference STT stream for a mic track that
 * has been uncovered for `FALLBACK_DELAY_MS`, closing it within a second once a
 * client covers that track again.
 *
 * Finals land in the same draft `Meeting` the clients write to, tagged
 * `lk:<identity>:<n>`, so finalize can de-duplicate a handover.
 *
 * The API starts it on boot when LiveKit is configured (see `startNotesWorker`);
 * `bun run worker:huddle-notes` runs it on its own for debugging. It needs
 * LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET and uses
 * LIVEKIT_NOTES_STT_MODEL (default `deepgram/nova-3`). With no creds, or
 * LIVEKIT_NOTES_FALLBACK=off, it does nothing and the client path still works.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AudioStream, Room, RoomEvent, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node'
import { AgentServer, JobContext, WorkerOptions, defineAgent, inference, initializeLogger, stt } from '@livekit/agents'
import { liveKitConfig, type LiveKitConfig } from '../lib/livekit'
import {
  NOTES_AGENT_ATTRIBUTE,
  NOTES_AGENT_NAME,
  notesFallbackAvailability,
  notesSttModel,
  parseRoomMetadata,
} from '../lib/livekit-notes'
import { NOTES_COVERAGE_TICK_MS, NotesCoverage, isNotesAgent, type NotesParticipant } from '../services/huddle-notes-coverage'

/** How often a stream's seconds are charged. */
const FLUSH_INTERVAL_MS = 60_000

/**
 * Each job runs in a child `bun` process that imports this file, so the worker
 * is identified by path — an agent object is stringified into the module name.
 */
const WORKER_FILE = fileURLToPath(import.meta.url)

/**
 * The job process imports that path with `pathToFileURL(...).pathname`, which
 * leaves a space as `%20` and then fails to resolve it — and desktop workspaces
 * live under `Application Support`. A one-line re-export in a space-free temp
 * directory imports fine, because a `file://` URL is decoded properly.
 */
let agentEntry: string | null = null
function agentEntryPath(): string {
  if (!WORKER_FILE.includes(' ')) return WORKER_FILE
  if (agentEntry) return agentEntry
  const dir = mkdtempSync(join(tmpdir(), 'shogo-huddle-notes-'))
  agentEntry = join(dir, 'agent.ts')
  writeFileSync(agentEntry, `export { default } from ${JSON.stringify(pathToFileURL(WORKER_FILE).href)}\n`)
  return agentEntry
}

/** How long boot waits for LiveKit to hand back a worker id. */
const REGISTER_TIMEOUT_MS = 15_000

interface StreamMeter {
  identity: string
  seconds: number
  flushedSeconds: number
  streamNo: number
  flushNo: number
}

/**
 * The parts of the job that touch our own database, behind one seam so the
 * coverage and metering logic can be exercised without LiveKit or Prisma.
 */
export interface NotesJobDeps {
  appendFinal(input: { huddleId: string; identity: string; text: string; start: number; end: number; itemId: string }): Promise<void>
  meteredSeconds(input: {
    huddleId: string
    identity: string
    seconds: number
    streamNo: number
    flushNo: number
    /** Everything the job has pushed so far; a replayed flush charges nothing. */
    totalSeconds?: number
  }): Promise<void>
  notesEnabled(huddleId: string): Promise<boolean>
  balanceOk(huddleId: string): Promise<boolean>
  notesOff(huddleId: string, reason: string, message: string): Promise<void>
  startedAt(huddleId: string): Promise<number | null>
}

function log(message: string): void {
  console.log(`[huddle-notes] ${message}`)
}

/** Participant view the coverage model needs, from whatever a room reports. */
export function notesParticipantsOf(room: {
  remoteParticipants: ReadonlyMap<string, RemoteParticipant>
  localParticipant?: { identity: string }
}): NotesParticipant[] {
  const participants: NotesParticipant[] = []
  for (const [identity, participant] of room.remoteParticipants) {
    if (isNotesAgent(identity)) continue
    const hasMicrophone = [...(participant.trackPublications?.values() ?? [])].some(
      (publication: any) => publication.kind === TrackKind.KIND_AUDIO && publication.source !== 3 /* SCREEN_SHARE_AUDIO */,
    )
    participants.push({
      identity,
      hasMicrophone,
      muted: (participant as any).isMicrophoneEnabled === false,
      attributes: participant.attributes ?? {},
    })
  }
  return participants
}

/**
 * Run one job. Kept separate from the worker bootstrap so it can be driven by
 * a fake room in tests and so the shutdown path is explicit.
 */
export async function runNotesJob(options: {
  huddleId: string
  deps: NotesJobDeps
  room: Room
  sttFor?: (identity: string) => { stream: () => any }
  now?: () => number
}): Promise<void> {
  const { huddleId, deps, room } = options
  const now = options.now ?? Date.now
  const sttFor = options.sttFor ?? (() => new inference.STT({ model: notesSttModel(), language: 'multi' } as any))
  const offsetStart = (await deps.startedAt(huddleId)) ?? now()

  const coverage = new NotesCoverage()
  const open = new Map<string, { close: () => void; meters: StreamMeter }>()
  const meters: StreamMeter[] = []
  let notesOn = true
  let stopping = false

  const secondsOf = (at: number) => Math.max(0, (at - offsetStart) / 1000)

  /** Everything this job has pushed into STT so far, so a replay charges nothing. */
  const billedSoFar = () => meters.reduce((sum, meter) => sum + meter.seconds, 0)

  const flush = async (meter: StreamMeter) => {
    const delta = Math.round(meter.seconds - meter.flushedSeconds)
    if (delta <= 0) return
    meter.flushedSeconds += delta
    meter.flushNo += 1
    try {
      await deps.meteredSeconds({
        huddleId,
        identity: meter.identity,
        seconds: delta,
        streamNo: meter.streamNo,
        flushNo: meter.flushNo,
        totalSeconds: billedSoFar(),
      })
    } catch (err) {
      console.warn('[huddle-notes] metering failed:', (err as Error).message)
    }
  }

  const stopStreams = async (reason?: string) => {
    if (stopping) return
    stopping = true
    for (const [, stream] of open) stream.close()
    open.clear()
    coverage.clear()
    for (const meter of meters) await flush(meter)
    if (reason) await deps.notesOff(huddleId, reason, 'This workspace is out of usage credit').catch(() => {})
  }

  const startStream = async (identity: string) => {
    const participant = room.remoteParticipants.get(identity)
    const publication = participant
      ? [...(participant.trackPublications?.values() ?? [])].find(
          (candidate: any) => candidate.kind === TrackKind.KIND_AUDIO && candidate.source !== 3,
        )
      : undefined
    const track = (publication as any)?.track as RemoteTrack | undefined
    if (!track) return

    const meter: StreamMeter = { identity, seconds: 0, flushedSeconds: 0, streamNo: meters.length + 1, flushNo: 0 }
    meters.push(meter)
    const engine = sttFor(identity)
    const speck = engine.stream()
    const audio = new AudioStream(track, 16_000)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      void audio.cancel().catch(() => {})
      try {
        speck.endInput?.()
      } catch {}
    }
    open.set(identity, { close, meters: meter })
    log(`covering ${identity} with ${notesSttModel()}`)

    void (async () => {
      try {
        for await (const event of speck) {
          if (event?.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) continue
          const text = String(event.alternatives?.[0]?.text ?? '').trim()
          if (!text) continue
          const at = secondsOf(now())
          await deps.appendFinal({ huddleId, identity, text, start: Math.max(0, at - 3), end: at, itemId: `lk:${identity}:${meter.streamNo}` })
        }
      } catch (err) {
        if (!closed) log(`stream for ${identity} ended: ${(err as Error).message}`)
      }
    })()

    // Frames are dropped once the stream closes, so a covered track costs nothing.
    void (async () => {
      let lastFlush = now()
      try {
        for await (const frame of audio) {
          if (closed || !notesOn) continue
          speck.pushFrame(frame)
          meter.seconds += frame.samplesPerChannel / frame.sampleRate
          if (now() - lastFlush >= FLUSH_INTERVAL_MS) {
            lastFlush = now()
            await flush(meter)
            if (!(await deps.balanceOk(huddleId))) {
              notesOn = false
              await stopStreams('usage_limit_reached')
              return
            }
          }
        }
      } catch (err) {
        if (!closed) log(`audio for ${identity} stopped: ${(err as Error).message}`)
      }
    })()
  }

  const tick = async () => {
    // The room metadata is only a hint; the huddle row is the source of truth,
    // so a toggle whose metadata write failed still stops the meter.
    if (notesOn && !(await deps.notesEnabled(huddleId))) {
      notesOn = false
      await stopStreams()
      return
    }
    const participants = notesParticipantsOf(room as any)
    const { start, stop } = coverage.sync(participants, now())
    for (const identity of stop) {
      open.get(identity)?.close()
      open.delete(identity)
    }
    for (const identity of start) if (notesOn) await startStream(identity)
  }

  room.on(RoomEvent.ParticipantAttributesChanged, () => void tick())
  room.on(RoomEvent.ParticipantConnected, () => void tick())
  room.on(RoomEvent.ParticipantDisconnected, () => void tick())
  room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
    const state = parseRoomMetadata(metadata)
    if (state.notes === false) {
      notesOn = false
      void stopStreams()
    }
  })

  const timer = setInterval(() => void tick(), NOTES_COVERAGE_TICK_MS)
  try {
    await tick()
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const humans = [...room.remoteParticipants.keys()].filter((identity) => !isNotesAgent(identity))
        if (!notesOn || humans.length === 0) {
          clearInterval(check)
          resolve()
        }
      }, NOTES_COVERAGE_TICK_MS)
      room.on(RoomEvent.Disconnected, () => {
        clearInterval(check)
        resolve()
      })
    })
  } finally {
    clearInterval(timer)
    await stopStreams()
  }
}

/** LiveKit worker bootstrap. */
const worker = defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = parseRoomMetadata(ctx.job.metadata)
    const huddleId = metadata.huddleId
    if (!huddleId) {
      log('job without a huddleId; leaving')
      return
    }
    const { appendStreamFinal, ensureHuddleNotesDraft } = await import('../services/meeting.service')
    const { findHuddleNotesTarget, notesLivekitFallback } = await import('../services/huddle.service')
    const { prisma } = await import('../lib/prisma')

    await ctx.connect()
    // Two dispatches for one room (a raced toggle, two pods) would each
    // transcribe and bill the same tracks. The first one in owns the room.
    const rival = [...(ctx.room as any).remoteParticipants.values()].find(
      (participant: any) => participant?.attributes?.[NOTES_AGENT_ATTRIBUTE] === '1',
    ) as any
    if (rival) {
      log(`another notes agent (${rival.identity}) is already covering this room; leaving`)
      return
    }
    try {
      await (ctx.room as any).localParticipant?.setAttributes?.({ [NOTES_AGENT_ATTRIBUTE]: '1' })
    } catch (err) {
      log(`could not mark this agent in the room: ${(err as Error).message}`)
    }
    const draft = await ensureHuddleNotesDraft(huddleId)

    await runNotesJob({
      huddleId,
      room: ctx.room as any,
      deps: {
        async appendFinal(input) {
          await appendStreamFinal(
            draft.id,
            {
              itemId: input.itemId,
              segment: { start: input.start, end: input.end, text: input.text },
              speaker: input.identity,
            },
            { attempts: 25 },
          )
        },
        async meteredSeconds(input) {
          await notesLivekitFallback(input)
        },
        async notesEnabled(id) {
          const row = await prisma.huddle.findUnique({ where: { id }, select: { notesEnabled: true } })
          return row?.notesEnabled !== false
        },
        async balanceOk(id) {
          const target = await findHuddleNotesTarget(id)
          if (!target) return true
          const { checkUsageBalance } = await import('../services/billing.service')
          return (await checkUsageBalance(target.workspaceId)).ok
        },
        async notesOff(id, reason, message) {
          await findHuddleNotesTarget(id).then((target) => target && prisma.huddle.update({ where: { id }, data: { notesEnabled: false } }))
          await notesLivekitFallback({ huddleId: id, identity: 'system', seconds: 0, streamNo: 0, flushNo: 0, reason, message })
        },
        async startedAt(id) {
          const row = await prisma.huddle.findUnique({ where: { id }, select: { startedAt: true } })
          return row ? new Date(row.startedAt).getTime() : null
        },
      },
    })
  },
})

// The job process imports this module and requires the agent as its default export.
export default worker

/**
 * Start the worker. Called on boot (and from the CLI entry); a no-op without
 * LiveKit creds. Returns the server so a test can drive it and close it again.
 */
export async function startNotesWorker(): Promise<any | null> {
  const availability = notesFallbackAvailability()
  if (!availability.ok) {
    log(`not starting: ${availability.reason}`)
    return null
  }
  const config = liveKitConfig()
  if (!config) return null
  initializeLogger({ pretty: process.env.NODE_ENV !== 'production', level: process.env.LOG_LEVEL ?? 'info' })
  const server: any = new AgentServer(serverOptions(config))
  // run() only settles when the worker shuts down, so it cannot be awaited: the
  // registration to wait on is the id LiveKit hands back (it starts out as
  // 'unregistered').
  const running = server.run().catch((err: Error) => log(`stopped: ${err.message}`))
  const registered = () => Boolean(server.id) && server.id !== 'unregistered'
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (!registered() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  if (!registered()) {
    // Never take the API down with it: the fallback is optional, the call is not.
    log(`could not register with LiveKit (${config.url}); notes stay on the client path`)
    await server.close?.().catch(() => {})
    return null
  }
  void running
  log(`registered with LiveKit as ${NOTES_AGENT_NAME} (${config.url})`)
  return server
}

/**
 * `wsURL`/`apiKey`/`apiSecret` are always passed explicitly: WorkerOptions
 * defaults `wsURL` to localhost before the server can fall back to
 * LIVEKIT_URL, so leaving them out would pin Cloud deployments to localhost.
 * Jobs run in forked children (`production: false` keeps idle ones at zero);
 * the port is for the health endpoint only, so let the OS pick it.
 */
function serverOptions(config: LiveKitConfig): any {
  return new WorkerOptions({
    agent: agentEntryPath(),
    agentName: NOTES_AGENT_NAME,
    wsURL: config.url,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    production: false,
    port: 0,
    // Hidden and subscribe-only: it never shows in a tile, roster or count,
    // and it can never publish audio into the call.
    permissions: { canSubscribe: true, canPublish: false, canPublishData: false, hidden: true },
    requestFunc: async (job: any) => {
      // Accepting is explicit in JS: an un-accepted request just sits until
      // LiveKit times it out, which is exactly how the fallback stays dark.
      const huddleId = parseRoomMetadata(job?.room?.metadata).huddleId ?? parseRoomMetadata(job?.job?.metadata).huddleId
      if (!huddleId) {
        await job.reject()
        return
      }
      await job.accept()
    },
  } as any)
}

if (import.meta.main) {
  if (!liveKitConfig()) {
    console.error('[huddle-notes] LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required')
    process.exit(1)
  }
  void startNotesWorker()
}

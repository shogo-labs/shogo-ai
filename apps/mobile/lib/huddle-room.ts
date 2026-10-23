// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One huddle's LiveKit room, on any platform: the local mic (plus camera and
 * screen when turned on), remote audio, and the video tracks for the stage to
 * render. On the web each remote speaker gets a hidden <audio> element; native
 * WebRTC plays remote audio by itself. `huddle-media` picks this up per platform.
 */
import {
  ConnectionQuality,
  DisconnectReason,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteTrack,
  type TextStreamReader,
  type TrackPublication,
} from 'livekit-client'
import type { CameraEffectsConfig } from './huddle-camera-effects'
import {
  CAPTION_TOPIC,
  captionAttributes,
  captionFromAttributes,
  partialAllowed,
  type CaptionLine,
} from './huddle-captions'

/** A camera or screen track to show on the stage. `track` is the LiveKit track (attach it to render). */
export interface HuddleVideoTile {
  key: string
  userId: string
  name: string
  source: 'camera' | 'screen'
  isLocal: boolean
  track: Track
  participant: Participant
  publication: TrackPublication
}

export type ConnectionQualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

/** One person in the call as the room reports it: who they are and what they're doing right now. */
export interface HuddleParticipantState {
  userId: string
  name: string
  image: string | null
  isLocal: boolean
  speaking: boolean
  muted: boolean
  cameraOn: boolean
  screenOn: boolean
  quality: ConnectionQualityLevel
  /** When their hand went up (ms since epoch), or null when it is down. */
  handRaisedAt: number | null
  /** An outside guest let in through the huddle link. */
  guest: boolean
  /** Their own device is streaming their audio to the notes transcriber. */
  notesSelf: boolean
  /** Their device can't stream its own audio (a phone), so a web or desktop client covers them. */
  notesNeedsCover: boolean
}

/** An emoji someone sent to the call; it floats over the video for a few seconds. */
export interface HuddleReactionEvent {
  id: string
  userId: string
  name: string
  emoji: string
  at: number
}

/** What the server says the workspace agent is doing after "hey Shogo". */
export interface HuddleWakeNotice {
  /** The person whose words woke it. */
  by: string
  /** The wake note in the chat, when there is one. */
  messageId: string | null
  status: 'running' | 'replied' | 'failed' | 'limit'
  reason?: string
}

export type HuddleDeviceKind = 'audioinput' | 'videoinput' | 'audiooutput'

export interface HuddleDevice {
  id: string
  label: string
}

/** What you chose before joining: join muted, with the camera on, with these devices and effects. */
export interface HuddleMediaOptions {
  startMuted?: boolean
  startCamera?: boolean
  micId?: string | null
  cameraId?: string | null
  speakerId?: string | null
  effects?: CameraEffectsConfig
}

/** Topic for the small messages (reactions) sent between participants. */
export const HUDDLE_DATA_TOPIC = 'huddle'
/**
 * Topic the server uses to tell the whole room what the workspace agent is
 * doing after someone says "hey Shogo". Server-sent, so it reaches guests and
 * phones that have no conversation bus of their own.
 */
export const HUDDLE_WAKE_TOPIC = 'shogo.huddle'
/** Participant attribute that holds when a hand went up; attributes reach people who join later. */
export const HAND_ATTRIBUTE = 'hand'
/**
 * Participant attribute saying whether this device streams its own audio to the
 * notes transcriber: `'self'` while the stream is live, `'unsupported'` when it
 * can't (a phone has no way to tap PCM). Everyone sees it, so exactly one web or
 * desktop client covers a phone, and it stops the moment the phone's attribute
 * appears.
 */
export const NOTES_ATTRIBUTE = 'notes'

/** One remote person's microphone, tapped by a covering client for huddle notes. */
export interface HuddleRemoteAudio {
  userId: string
  stream: MediaStream
  notesSelf: boolean
  notesNeedsCover: boolean
}

export interface HuddleMediaHandlers {
  /** Identities (user ids) currently speaking, loudest first. */
  onSpeakers: (userIds: string[]) => void
  onConnection: (state: 'connected' | 'reconnecting') => void
  /** The room went away without us asking (kicked, network gone for good, room closed). */
  onDropped: (reason: string) => void
  /** The browser blocked playback until the next user gesture. */
  onPlaybackBlocked: (blocked: boolean) => void
  /** Camera and screen tracks changed (including our own). */
  onVideo?: (tiles: HuddleVideoTile[]) => void
  /** Our camera or screen turned on or off, including from outside the app (the browser's "Stop sharing"). `muted` follows the mic, including a host muting you. */
  onLocalMedia?: (state: { camera: boolean; screen: boolean; muted?: boolean }) => void
  /** Everyone in the room with their mute, camera, connection and raised-hand state. */
  onParticipants?: (participants: HuddleParticipantState[]) => void
  onReaction?: (reaction: HuddleReactionEvent) => void
  /** Plugged or unplugged a mic, camera, or speaker. */
  onDevicesChanged?: () => void
  /** Something optional failed (a camera effect, a device switch); the call carries on. */
  onError?: (message: string) => void
  /** A caption line arrived from whoever transcribed that speaker, or was just published here. */
  onCaption?: (line: CaptionLine) => void
  /** The server said the workspace agent is on it, answered, or couldn't. */
  onHuddleWake?: (notice: HuddleWakeNotice) => void
}

export interface HuddleMedia {
  setMuted: (muted: boolean) => Promise<void>
  setCamera: (on: boolean) => Promise<void>
  setScreenShare: (on: boolean) => Promise<void>
  /** Retry playback after a click when autoplay was blocked. */
  resumePlayback: () => Promise<void>
  disconnect: () => Promise<void>
  sendReaction?: (emoji: string) => Promise<void>
  setHandRaised?: (raised: boolean) => Promise<void>
  listDevices?: (kind: HuddleDeviceKind) => Promise<HuddleDevice[]>
  getActiveDevice?: (kind: HuddleDeviceKind) => string | undefined
  switchDevice?: (kind: HuddleDeviceKind, id: string) => Promise<void>
  /** Apply blur / background / framing / low-light to the camera now and whenever it turns on. */
  setCameraEffects?: (config: CameraEffectsConfig) => Promise<void>
  /** This device's microphone as a MediaStream, for the huddle-notes transcriber. */
  localMicStream?: () => MediaStream | null
  /**
   * Whether that participant's mic is muted. LiveKit keeps the publication
   * while muted, so the transcriber has to ask rather than assume a stream is
   * audible. `identity` may be this device's own.
   */
  micMuted?: (identity: string) => boolean
  /** Each remote participant's microphone, so one web or desktop client can cover phones. */
  remoteAudioStreams?: () => HuddleRemoteAudio[]
  /** Publish whether this device streams its own audio: `'self'`, `'unsupported'`, or `''` to clear. */
  setNotesSource?: (state: 'self' | 'unsupported' | '') => Promise<void>
  /**
   * Publish one caption line into the room, so everyone (guests included) sees
   * it live. `speakerId` is the person whose words these are — the device's own
   * id, or one it covers. Best effort: a failed send never disturbs the call.
   */
  publishCaption?: (line: { itemId: string; speakerId: string; text: string; final: boolean; start?: number }) => Promise<void>
}

function dropReason(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this huddle somewhere else'
    case DisconnectReason.ROOM_DELETED:
      return 'The huddle ended'
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the huddle'
    default:
      return 'Lost connection to the huddle'
  }
}

function deviceError(err: unknown, what: 'camera' | 'screen'): Error {
  const message = err instanceof Error ? err.message : ''
  if (what === 'screen' && /denied|not allowed|permission|cancel|abort/i.test(message)) return new Error('Screen sharing was cancelled')
  if (/denied|not allowed|permission/i.test(message)) return new Error(`Shogo needs ${what} access`)
  return new Error(`Could not start your ${what}`)
}

function qualityOf(q: ConnectionQuality): ConnectionQualityLevel {
  switch (q) {
    case ConnectionQuality.Excellent:
      return 'excellent'
    case ConnectionQuality.Good:
      return 'good'
    case ConnectionQuality.Poor:
      return 'poor'
    case ConnectionQuality.Lost:
      return 'lost'
    default:
      return 'unknown'
  }
}

function parseMetadata(raw: string | undefined): { image?: string | null; guest?: boolean } {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Parse a reaction message from the data channel; anything else is ignored. */
export function parseHuddleData(payload: Uint8Array): { t: 'reaction'; emoji: string } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload))
    if (value?.t === 'reaction' && typeof value.emoji === 'string' && value.emoji.length > 0 && value.emoji.length <= 16) {
      return { t: 'reaction', emoji: value.emoji }
    }
  } catch {}
  return null
}

/** Parse the server's wake status message; anything malformed is ignored. */
export function parseHuddleWake(payload: Uint8Array): HuddleWakeNotice | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload))
    if (value?.type !== 'wake') return null
    const status = value.status
    if (status !== 'running' && status !== 'replied' && status !== 'failed' && status !== 'limit') return null
    return {
      by: typeof value.by === 'string' ? value.by : 'Someone',
      messageId: typeof value.messageId === 'string' ? value.messageId : null,
      status,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    }
  } catch {
    return null
  }
}

export function participantStateOf(participant: Participant, isLocal: boolean): HuddleParticipantState {
  const meta = parseMetadata(participant.metadata)
  const hand = Number(participant.attributes?.[HAND_ATTRIBUTE])
  const notes = participant.attributes?.[NOTES_ATTRIBUTE]
  return {
    userId: participant.identity,
    name: participant.name || participant.identity,
    image: meta.image ?? null,
    isLocal,
    speaking: participant.isSpeaking,
    muted: !participant.isMicrophoneEnabled,
    cameraOn: participant.isCameraEnabled,
    screenOn: participant.isScreenShareEnabled,
    quality: qualityOf(participant.connectionQuality),
    handRaisedAt: Number.isFinite(hand) && hand > 0 ? hand : null,
    guest: !!meta.guest,
    notesSelf: notes === 'self',
    notesNeedsCover: notes === 'unsupported',
  }
}

/** The media stream behind a participant's microphone, or null before it is published. */
function micStreamOf(participant: Participant): MediaStream | null {
  const track = participant.getTrackPublication(Track.Source.Microphone)?.track
  const media = track?.mediaStreamTrack
  return media ? new MediaStream([media]) : null
}

function tilesOf(participant: Participant, isLocal: boolean): HuddleVideoTile[] {
  const tiles: HuddleVideoTile[] = []
  for (const pub of participant.trackPublications.values()) {
    const track = pub.track
    if (!track || track.kind !== Track.Kind.Video || pub.isMuted) continue
    const source = pub.source === Track.Source.ScreenShare ? 'screen' : pub.source === Track.Source.Camera ? 'camera' : null
    if (!source) continue
    tiles.push({
      key: `${participant.identity}:${source}`,
      userId: participant.identity,
      name: participant.name || participant.identity,
      source,
      isLocal,
      track,
      participant,
      publication: pub,
    })
  }
  return tiles
}

export async function connectHuddleRoom(
  url: string,
  token: string,
  handlers: HuddleMediaHandlers,
  options: HuddleMediaOptions = {},
): Promise<HuddleMedia> {
  let effects: CameraEffectsConfig | null = options.effects ?? null
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(options.micId ? { deviceId: options.micId } : {}),
    },
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, ...(options.cameraId ? { deviceId: options.cameraId } : {}) },
    ...(options.speakerId ? { audioOutput: { deviceId: options.speakerId } } : {}),
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
    },
  })
  const elements = new Map<string, HTMLMediaElement[]>()
  /** Last partial caption published per speaker, so partials don't flood the room. */
  const lastPartialAt = new Map<string, number>()
  let leaving = false

  const emitVideo = () => {
    if (!handlers.onVideo) return
    const tiles = [
      ...tilesOf(room.localParticipant, true),
      ...[...room.remoteParticipants.values()].flatMap((p) => tilesOf(p, false)),
    ]
    handlers.onVideo(tiles)
  }
  const emitLocal = () =>
    handlers.onLocalMedia?.({
      camera: room.localParticipant.isCameraEnabled,
      screen: room.localParticipant.isScreenShareEnabled,
      muted: !room.localParticipant.isMicrophoneEnabled,
    })
  let participantsQueued = false
  const emitParticipants = () => {
    if (!handlers.onParticipants || participantsQueued) return
    participantsQueued = true
    // Many room events fire at once (a join publishes several tracks); report the result once.
    queueMicrotask(() => {
      participantsQueued = false
      if (room.state === 'disconnected') return
      handlers.onParticipants?.([
        participantStateOf(room.localParticipant, true),
        ...[...room.remoteParticipants.values()].map((p) => participantStateOf(p, false)),
      ])
    })
  }
  /** Attach the camera effects (or remove them) on the live camera track. */
  const applyEffects = async () => {
    const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track
    if (!(track instanceof LocalVideoTrack)) return
    try {
      const fx = await import('./huddle-camera-effects')
      if (!effects || !fx.hasCameraEffects(effects)) {
        if (track.getProcessor()) await track.stopProcessor()
        return
      }
      if (!fx.cameraEffectsSupported) {
        handlers.onError?.('Camera effects are not available on this device')
        return
      }
      const processor = new fx.CameraEffectsProcessor(effects)
      processor.onFramingUnavailable = () => handlers.onError?.('Auto-framing could not load. Check your connection and try again.')
      await track.setProcessor(processor as any)
    } catch {
      handlers.onError?.('Could not apply the camera effect')
    }
  }

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Video) {
      emitVideo()
      return
    }
    if (track.kind !== Track.Kind.Audio || typeof document === 'undefined') return
    const el = track.attach()
    el.style.display = 'none'
    document.body.appendChild(el)
    elements.set(track.sid ?? '', [...(elements.get(track.sid ?? '') ?? []), el])
  })
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Video) {
      // The publication still holds the track while this fires.
      queueMicrotask(emitVideo)
      return
    }
    // By the time this fires the track may already be detached, so remove our own copies too.
    for (const el of [...track.detach(), ...(elements.get(track.sid ?? '') ?? [])]) el.remove()
    elements.delete(track.sid ?? '')
  })
  room.on(RoomEvent.TrackUnpublished, () => {
    emitVideo()
    emitParticipants()
  })
  room.on(RoomEvent.TrackMuted, () => {
    emitVideo()
    emitLocal()
    emitParticipants()
  })
  room.on(RoomEvent.TrackUnmuted, () => {
    emitVideo()
    emitLocal()
    emitParticipants()
  })
  room.on(RoomEvent.ParticipantDisconnected, () => {
    emitVideo()
    emitParticipants()
  })
  room.on(RoomEvent.ParticipantConnected, emitParticipants)
  room.on(RoomEvent.TrackPublished, emitParticipants)
  room.on(RoomEvent.ParticipantMetadataChanged, emitParticipants)
  room.on(RoomEvent.ParticipantAttributesChanged, emitParticipants)
  room.on(RoomEvent.ConnectionQualityChanged, emitParticipants)
  room.on(RoomEvent.MediaDevicesChanged, () => handlers.onDevicesChanged?.())
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === HUDDLE_WAKE_TOPIC) {
      const wake = parseHuddleWake(payload)
      if (wake) handlers.onHuddleWake?.(wake)
      return
    }
    if (topic !== HUDDLE_DATA_TOPIC || !participant) return
    const message = parseHuddleData(payload)
    if (!message) return
    handlers.onReaction?.({
      id: `${participant.identity}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      userId: participant.identity,
      name: participant.name || participant.identity,
      emoji: message.emoji,
      at: Date.now(),
    })
  })
  room.on(RoomEvent.LocalTrackPublished, () => {
    emitVideo()
    emitLocal()
    emitParticipants()
  })
  room.on(RoomEvent.LocalTrackUnpublished, () => {
    emitVideo()
    emitLocal()
    emitParticipants()
  })
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    handlers.onSpeakers(speakers.map((s) => s.identity))
    emitParticipants()
  })
  room.on(RoomEvent.Reconnecting, () => handlers.onConnection('reconnecting'))
  room.on(RoomEvent.Reconnected, () => handlers.onConnection('connected'))
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => handlers.onPlaybackBlocked(!room.canPlaybackAudio))
  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    for (const list of elements.values()) list.forEach((el) => el.remove())
    elements.clear()
    handlers.onVideo?.([])
    if (!leaving) handlers.onDropped(dropReason(reason))
  })

  /**
   * Captions arrive as text streams on LiveKit's own transcription topic, from
   * whichever participant transcribed that speaker (their own device, a coverer,
   * or the hidden fallback worker). The handler has to be in place before the
   * room connects, or a line said while connecting is lost.
   */
  if (handlers.onCaption) {
    room.registerTextStreamHandler(CAPTION_TOPIC, (reader: TextStreamReader, info: { identity: string }) => {
      void (async () => {
        try {
          const caption = captionFromAttributes(reader.info.attributes, info.identity)
          if (!caption) return
          const text = await reader.readAll()
          if (!text.trim()) return
          handlers.onCaption?.({ ...caption, text, at: Date.now(), start: 0 })
        } catch {
          // A malformed or abandoned stream is one lost caption; the call is fine.
        }
      })()
    })
  }

  await room.connect(url, token)
  try {
    await room.localParticipant.setMicrophoneEnabled(!options.startMuted)
  } catch (err) {
    leaving = true
    await room.disconnect()
    const message = err instanceof Error ? err.message : ''
    throw new Error(/denied|not allowed|permission/i.test(message) ? 'Shogo needs microphone access to join a huddle' : 'Could not start your microphone')
  }
  handlers.onConnection('connected')
  handlers.onPlaybackBlocked(!room.canPlaybackAudio)
  if (options.startCamera) {
    try {
      await room.localParticipant.setCameraEnabled(true)
      await applyEffects()
    } catch (err) {
      handlers.onError?.(deviceError(err, 'camera').message)
    }
  }
  emitLocal()
  emitVideo()
  emitParticipants()

  return {
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted)
    },
    setCamera: async (on) => {
      try {
        await room.localParticipant.setCameraEnabled(on)
        if (on) await applyEffects()
      } catch (err) {
        throw deviceError(err, 'camera')
      } finally {
        emitLocal()
        emitVideo()
      }
    },
    setScreenShare: async (on) => {
      try {
        await room.localParticipant.setScreenShareEnabled(on, { audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' })
      } catch (err) {
        throw deviceError(err, 'screen')
      } finally {
        emitLocal()
        emitVideo()
      }
    },
    resumePlayback: () => room.startAudio(),
    sendReaction: async (emoji) => {
      const data = new TextEncoder().encode(JSON.stringify({ t: 'reaction', emoji }))
      await room.localParticipant.publishData(data, { reliable: true, topic: HUDDLE_DATA_TOPIC })
      handlers.onReaction?.({
        id: `${room.localParticipant.identity}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        userId: room.localParticipant.identity,
        name: room.localParticipant.name || room.localParticipant.identity,
        emoji,
        at: Date.now(),
      })
    },
    setHandRaised: async (raised) => {
      await room.localParticipant.setAttributes({ [HAND_ATTRIBUTE]: raised ? String(Date.now()) : '' })
      emitParticipants()
    },
    listDevices: async (kind) => {
      try {
        const devices = await Room.getLocalDevices(kind, true)
        return devices.map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'} ${i + 1}` }))
      } catch {
        return []
      }
    },
    getActiveDevice: (kind) => room.getActiveDevice(kind),
    switchDevice: async (kind, id) => {
      try {
        await room.switchActiveDevice(kind, id)
      } catch {
        throw new Error(`Could not switch your ${kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker'}`)
      }
    },
    setCameraEffects: async (config) => {
      effects = config
      await applyEffects()
    },
    localMicStream: () => micStreamOf(room.localParticipant),
    micMuted: (identity) => {
      const participant =
        identity === room.localParticipant?.identity
          ? room.localParticipant
          : room.remoteParticipants.get(identity)
      if (!participant) return true
      const pub = participant.getTrackPublication?.(Track.Source.Microphone)
      // No mic published at all is as silent as a muted one.
      return pub ? !!pub.isMuted : true
    },
    remoteAudioStreams: () =>
      [...room.remoteParticipants.values()].flatMap((p) => {
        const stream = micStreamOf(p)
        if (!stream) return []
        const notes = p.attributes?.[NOTES_ATTRIBUTE]
        return [{ userId: p.identity, stream, notesSelf: notes === 'self', notesNeedsCover: notes === 'unsupported' }]
      }),
    setNotesSource: async (state) => {
      await room.localParticipant.setAttributes({ [NOTES_ATTRIBUTE]: state })
      emitParticipants()
    },
    publishCaption: async (line) => {
      const now = Date.now()
      // Partials arrive many times a second; finals always go.
      if (!line.final) {
        if (!partialAllowed(lastPartialAt.get(line.speakerId), now)) return
        lastPartialAt.set(line.speakerId, now)
      }
      // The sender never receives its own text stream, so show it here as well.
      handlers.onCaption?.({ ...line, text: line.text, at: now, start: line.start ?? 0 })
      const speaker =
        line.speakerId === room.localParticipant.identity
          ? room.localParticipant
          : room.remoteParticipants.get(line.speakerId)
      const trackId = speaker?.getTrackPublication(Track.Source.Microphone)?.trackSid
      try {
        await room.localParticipant.sendText(line.text, {
          topic: CAPTION_TOPIC,
          attributes: captionAttributes({ itemId: line.itemId, speakerId: line.speakerId, final: line.final, trackId }),
        })
      } catch {
        // Captions are best effort; the line is still in the room's notes.
      }
    },
    disconnect: async () => {
      leaving = true
      await room.disconnect()
    },
  }
}

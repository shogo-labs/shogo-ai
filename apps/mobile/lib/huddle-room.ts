// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One huddle's LiveKit room, on any platform: the local mic (plus camera and
 * screen when turned on), remote audio, and the video tracks for the stage to
 * render. On the web each remote speaker gets a hidden <audio> element; native
 * WebRTC plays remote audio by itself. `huddle-media` picks this up per platform.
 */
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteTrack,
  type TrackPublication,
} from 'livekit-client'

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
  /** Our camera or screen turned on or off, including from outside the app (the browser's "Stop sharing"). */
  onLocalMedia?: (state: { camera: boolean; screen: boolean }) => void
}

export interface HuddleMedia {
  setMuted: (muted: boolean) => Promise<void>
  setCamera: (on: boolean) => Promise<void>
  setScreenShare: (on: boolean) => Promise<void>
  /** Retry playback after a click when autoplay was blocked. */
  resumePlayback: () => Promise<void>
  disconnect: () => Promise<void>
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

export async function connectHuddleRoom(url: string, token: string, handlers: HuddleMediaHandlers): Promise<HuddleMedia> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
    },
  })
  const elements = new Map<string, HTMLMediaElement[]>()
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
    })

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
  room.on(RoomEvent.TrackUnpublished, emitVideo)
  room.on(RoomEvent.TrackMuted, emitVideo)
  room.on(RoomEvent.TrackUnmuted, emitVideo)
  room.on(RoomEvent.ParticipantDisconnected, emitVideo)
  room.on(RoomEvent.LocalTrackPublished, () => {
    emitVideo()
    emitLocal()
  })
  room.on(RoomEvent.LocalTrackUnpublished, () => {
    emitVideo()
    emitLocal()
  })
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => handlers.onSpeakers(speakers.map((s) => s.identity)))
  room.on(RoomEvent.Reconnecting, () => handlers.onConnection('reconnecting'))
  room.on(RoomEvent.Reconnected, () => handlers.onConnection('connected'))
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => handlers.onPlaybackBlocked(!room.canPlaybackAudio))
  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    for (const list of elements.values()) list.forEach((el) => el.remove())
    elements.clear()
    handlers.onVideo?.([])
    if (!leaving) handlers.onDropped(dropReason(reason))
  })

  await room.connect(url, token)
  try {
    await room.localParticipant.setMicrophoneEnabled(true)
  } catch (err) {
    leaving = true
    await room.disconnect()
    const message = err instanceof Error ? err.message : ''
    throw new Error(/denied|not allowed|permission/i.test(message) ? 'Shogo needs microphone access to join a huddle' : 'Could not start your microphone')
  }
  handlers.onConnection('connected')
  handlers.onPlaybackBlocked(!room.canPlaybackAudio)
  emitVideo()

  return {
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted)
    },
    setCamera: async (on) => {
      try {
        await room.localParticipant.setCameraEnabled(on)
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
    disconnect: async () => {
      leaving = true
      await room.disconnect()
    },
  }
}

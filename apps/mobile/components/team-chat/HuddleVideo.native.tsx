// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** One huddle camera or screen track on iOS/Android, via LiveKit's native video view. */
import { huddleVideoSupported, type HuddleVideoTile } from '../../lib/huddle-call'

type VideoTrackComponent = typeof import('@livekit/react-native').VideoTrack

// Only touch the native view once huddle-media has confirmed the WebRTC module is in this build.
const VideoTrack: VideoTrackComponent | null = huddleVideoSupported
  ? (require('@livekit/react-native') as typeof import('@livekit/react-native')).VideoTrack
  : null

export function HuddleVideo({ tile, fit }: { tile: HuddleVideoTile; fit: 'cover' | 'contain' }) {
  if (!VideoTrack) return null
  return (
    <VideoTrack
      trackRef={{ participant: tile.participant, publication: tile.publication, source: tile.publication.source }}
      objectFit={fit}
      mirror={tile.isLocal && tile.source === 'camera'}
      style={{ width: '100%', height: '100%' }}
    />
  )
}

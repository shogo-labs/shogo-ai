// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle media on iOS and Android, through LiveKit's React Native WebRTC.
 * Builds made before the WebRTC module shipped don't have it, so it is loaded
 * only when present; those builds report huddles as unsupported and offer
 * "join from web or desktop" instead of crashing.
 *
 * Screen sharing from a phone needs a broadcast extension (iOS) and a
 * foreground service (Android), so it stays off here.
 */
import { NativeModules } from 'react-native'
import type { HuddleMedia, HuddleMediaHandlers } from './huddle-room'

export type { HuddleMedia, HuddleMediaHandlers, HuddleVideoTile } from './huddle-room'

type LiveKitNative = typeof import('@livekit/react-native')

function loadLiveKit(): LiveKitNative | null {
  if (!NativeModules.WebRTCModule) return null
  try {
    const liveKit = require('@livekit/react-native') as LiveKitNative
    liveKit.registerGlobals()
    return liveKit
  } catch (err) {
    console.warn('[Huddles] LiveKit native module unavailable:', (err as Error).message)
    return null
  }
}

const liveKit = loadLiveKit()

export const huddleMediaSupported = liveKit !== null
export const huddleVideoSupported = liveKit !== null
export const screenShareSupported = false

export async function connectHuddleMedia(url: string, token: string, handlers: HuddleMediaHandlers): Promise<HuddleMedia> {
  if (!liveKit) throw new Error('Huddles are available on web and desktop for now')
  const lk = liveKit
  // Required lazily: livekit-client must load after registerGlobals() has installed WebRTC.
  const { connectHuddleRoom } = require('./huddle-room') as typeof import('./huddle-room')

  await lk.AudioSession.startAudioSession()
  let sessionOpen = true
  const closeSession = () => {
    if (!sessionOpen) return
    sessionOpen = false
    void lk.AudioSession.stopAudioSession().catch(() => {})
  }
  try {
    const media = await connectHuddleRoom(url, token, {
      ...handlers,
      onDropped: (reason) => {
        closeSession()
        handlers.onDropped(reason)
      },
    })
    return {
      ...media,
      disconnect: async () => {
        try {
          await media.disconnect()
        } finally {
          closeSession()
        }
      },
    }
  } catch (err) {
    closeSession()
    throw err
  }
}

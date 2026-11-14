// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inline player for a workspace video. Loaded lazily by GenerateVideoWidget
 * so `expo-video`'s native module is only pulled in when a video renders.
 *
 * Workspace downloads need the session, and a media element sends the session
 * cookie for the app's own origin by itself — so the URL is handed to the
 * player directly on both platforms. Fetching it first (`agentFetch` → blob)
 * downloaded the whole clip before the first frame (SHO-387).
 */

import { useEffect, useState } from "react"
import { ActivityIndicator, Platform, View } from "react-native"
import { useVideoPlayer, VideoView, type VideoSource } from "expo-video"
import { getAgentImageSource } from "../../../lib/agent-image-source"

export function useAgentVideoSource(
  uri: string,
  options: { sendSession?: boolean } = {},
): { source: VideoSource; failed: boolean } {
  const sendSession = options.sendSession ?? true
  const [source, setSource] = useState<VideoSource>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)

    if (Platform.OS !== "web") {
      // A URL off the app's own origin never gets the session cookie, so the
      // header (not a blob) carries it into the native player.
      const native = sendSession ? getAgentImageSource(uri) : { uri }
      setSource({ uri: native.uri ?? uri, headers: native.headers as Record<string, string> | undefined })
      return
    }

    // Web: the element streams the URL itself, so the player can start on the
    // first range and seek without a full download.
    setSource({ uri })
  }, [uri, sendSession])

  return { source, failed }
}

export interface GeneratedVideoPlayerProps {
  url: string
  width: number
  aspectRatio: number
  onError?: () => void
}

export default function GeneratedVideoPlayer({ url, width, aspectRatio, onError }: GeneratedVideoPlayerProps) {
  const { source, failed } = useAgentVideoSource(url)
  const player = useVideoPlayer(source, (p) => {
    p.loop = true
    p.muted = true
  })

  useEffect(() => {
    if (failed) onError?.()
  }, [failed, onError])

  // Without a fetch to fail, a dead URL or an undecodable file surfaces as the
  // player's own error status.
  useEffect(() => {
    if (player.status === "error") onError?.()
    const subscription = player.addListener("statusChange", ({ status }) => {
      if (status === "error") onError?.()
    })
    return () => subscription.remove()
  }, [player, onError])

  return (
    <View
      className="items-center justify-center overflow-hidden rounded-lg bg-black"
      style={{ width, aspectRatio }}
    >
      {source ? (
        <VideoView
          player={player}
          style={{ width, height: width / aspectRatio }}
          contentFit="contain"
          nativeControls
          fullscreenOptions={{ enable: true }}
          allowsPictureInPicture
        />
      ) : (
        <ActivityIndicator size="small" />
      )}
    </View>
  )
}

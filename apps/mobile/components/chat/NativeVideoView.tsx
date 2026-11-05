// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full-size in-app player for VideoPreviewModal on iOS / Android. Loaded
 * lazily so `expo-video`'s native module is only pulled in when a video opens.
 */

import { useEffect } from "react"
import { ActivityIndicator, View } from "react-native"
import { useVideoPlayer, VideoView } from "expo-video"
import { API_URL } from "../../lib/api-url"
import { isUrlOnOrigin } from "../../lib/same-origin-url"
import { useAgentVideoSource } from "./turns/GeneratedVideoPlayer"

export interface NativeVideoViewProps {
  url: string
  width: number
  height: number
  onError?: () => void
}

export default function NativeVideoView({ url, width, height, onError }: NativeVideoViewProps) {
  // Chat markdown can point at any host; only the app's own origin gets the
  // signed-in session attached.
  const { source, failed } = useAgentVideoSource(url, { sendSession: isUrlOnOrigin(url, API_URL) })
  const player = useVideoPlayer(source, (p) => {
    p.loop = false
    p.play()
  })

  useEffect(() => {
    if (failed) onError?.()
  }, [failed, onError])

  // A dead URL or a format the platform can't decode never fails the fetch
  // above; the player reports it through its status instead.
  useEffect(() => {
    if (player.status === "error") onError?.()
    const subscription = player.addListener("statusChange", ({ status }) => {
      if (status === "error") onError?.()
    })
    return () => subscription.remove()
  }, [player, onError])

  return (
    <View className="items-center justify-center bg-black" style={{ width, height }}>
      {source ? (
        <VideoView
          player={player}
          style={{ width, height }}
          contentFit="contain"
          nativeControls
          fullscreenOptions={{ enable: true }}
          allowsPictureInPicture
        />
      ) : (
        <ActivityIndicator size="large" color="#ffffff" />
      )}
    </View>
  )
}

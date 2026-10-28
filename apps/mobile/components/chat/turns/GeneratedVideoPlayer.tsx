// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inline player for a workspace video. Loaded lazily by GenerateVideoWidget
 * so `expo-video`'s native module is only pulled in when a video renders.
 *
 * Workspace downloads need the session: web fetches the file with
 * `agentFetch` and plays a blob URL; native passes the auth headers to the
 * player source.
 */

import { useEffect, useState } from "react"
import { ActivityIndicator, Platform, View } from "react-native"
import { useVideoPlayer, VideoView, type VideoSource } from "expo-video"
import { agentFetch } from "../../../lib/agent-fetch"
import { getAgentImageSource } from "../../../lib/agent-image-source"

function useAgentVideoSource(uri: string): { source: VideoSource; failed: boolean } {
  const [source, setSource] = useState<VideoSource>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setFailed(false)

    if (Platform.OS !== "web") {
      const native = getAgentImageSource(uri)
      setSource({ uri: native.uri ?? uri, headers: native.headers as Record<string, string> | undefined })
      return
    }

    setSource(null)
    void agentFetch(uri)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Video request failed (${response.status})`)
        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSource({ uri: objectUrl })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [uri])

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

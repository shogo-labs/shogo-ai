// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Image or video inside rendered chat markdown (iOS / Android).
 */
import React, { Suspense, lazy, useState } from "react"
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native"
import { PlayCircle } from "lucide-react-native"
import { useMarkdownImageUri, useMarkdownMedia, type MarkdownMediaTarget } from "./markdown-media"

const ImagePreviewModal = lazy(() => import("./ImagePreviewModal").then((m) => ({ default: m.ImagePreviewModal })))

function Unavailable({ label }: { label: string }) {
  return (
    <View testID="chat-media-unavailable" className="my-1 self-start rounded bg-muted px-2 py-1">
      <Text className="text-sm text-muted-foreground">Image unavailable: {label}</Text>
    </View>
  )
}

function MarkdownImage({ target }: { target: MarkdownMediaTarget }) {
  const uri = useMarkdownImageUri(target)
  const [failed, setFailed] = useState(false)
  const [aspectRatio, setAspectRatio] = useState(4 / 3)
  const [open, setOpen] = useState(false)
  if (!target.url || failed) return <Unavailable label={target.label} />
  if (!uri) {
    return (
      <View className="my-1 h-24 w-40 items-center justify-center rounded-md bg-muted">
        <ActivityIndicator size="small" />
      </View>
    )
  }
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={target.label}
        onPress={() => setOpen(true)}
        className="my-1 w-full max-w-[420px] overflow-hidden rounded-md border border-border"
      >
        <Image
          testID="chat-media-image"
          source={{ uri }}
          resizeMode="contain"
          style={{ width: "100%", aspectRatio }}
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source ?? {}
            if (width && height) setAspectRatio(width / height)
          }}
          onError={() => setFailed(true)}
        />
      </Pressable>
      {open ? (
        <Suspense fallback={null}>
          <ImagePreviewModal visible onClose={() => setOpen(false)} url={uri} title={target.label} alt={target.label} />
        </Suspense>
      ) : null}
    </>
  )
}

/** Native has no inline player; stored videos open in the system player. */
function MarkdownVideo({ target }: { target: MarkdownMediaTarget }) {
  const url = target.url
  if (!url || target.fromWorkspace) return <Unavailable label={target.label} />
  return (
    <Pressable
      testID="chat-media-video"
      accessibilityRole="button"
      accessibilityLabel={`Play ${target.label}`}
      onPress={() => void Linking.openURL(url).catch(() => {})}
      className="my-1 flex-row items-center gap-2 self-start rounded-md border border-border bg-muted px-3 py-2"
    >
      <PlayCircle size={18} className="text-foreground" />
      <Text className="text-sm text-foreground" numberOfLines={1}>{target.label}</Text>
    </Pressable>
  )
}

export function MarkdownMediaNative({ src, alt }: { src: string; alt?: string }) {
  const target = useMarkdownMedia(src, alt)
  return target.kind === "video" ? <MarkdownVideo target={target} /> : <MarkdownImage target={target} />
}

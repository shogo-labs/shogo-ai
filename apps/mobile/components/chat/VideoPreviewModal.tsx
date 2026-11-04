// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VideoPreviewModal
 *
 * In-app video viewer shown when the user taps a video in chat. On
 * web/desktop we render a native <video> element; on iOS/Android we play it
 * with expo-video (loaded lazily) instead of handing off to the browser. On
 * phones it is full-screen with a safe-area header, like ImagePreviewModal.
 */

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Platform, Text, useWindowDimensions, View } from "react-native"
import { VideoIcon, X } from "lucide-react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { cn } from "@shogo/shared-ui/primitives"
import { useSafeAreaInsetsOrZero } from "../../lib/use-safe-area-insets-or-zero"
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
} from "@/components/ui/modal"

// React Native Web forwards unknown host component names straight to the
// DOM, so a plain HTML <video> element works at runtime even though it
// isn't part of react-native's typed component set. Declare its props
// once, typed, instead of reaching for `@ts-ignore` at the call site.
interface WebVideoProps {
  src: string
  controls?: boolean
  autoPlay?: boolean
  style?: React.CSSProperties
}
const WebVideo = 'video' as unknown as React.FC<WebVideoProps>

const NativeVideoView = lazy(() => import("./NativeVideoView"))

export interface VideoPreviewModalProps {
  visible: boolean
  onClose: () => void
  /** data URL or remote URL of the video */
  url: string
  title?: string
}

export function VideoPreviewModal({
  visible,
  onClose,
  url,
  title = "Video preview",
}: VideoPreviewModalProps) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsetsOrZero()
  const isPhone = Platform.OS !== "web" && width < 600
  const [phoneArea, setPhoneArea] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const handleVideoError = useCallback(() => setFailed(true), [])

  useEffect(() => {
    if (visible) setFailed(false)
  }, [visible, url])

  // data: URLs are blocked by Electron's CSP — convert to a blob URL instead.
  const videoSrc = useMemo(() => {
    if (Platform.OS !== 'web' || !url.startsWith('data:')) return url
    try {
      const [header, base64] = url.split(',')
      const mime = header.match(/data:([^;]+)/)?.[1] ?? 'video/mp4'
      const bytes = atob(base64)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      return URL.createObjectURL(new Blob([arr], { type: mime }))
    } catch {
      return url
    }
  }, [url])

  useEffect(() => {
    return () => {
      if (videoSrc !== url) URL.revokeObjectURL(videoSrc)
    }
  }, [videoSrc, url])

  const panelMaxWidth = Math.min(Math.max(width - 32, 320), 960)
  const panelMaxHeight = Math.min(Math.max(height * 0.86, 320), 760)
  const videoHeight = Math.max(240, panelMaxHeight - 80)
  const BodyComponent: React.ElementType = isPhone ? GestureHandlerRootView : ModalBody

  // The native player can't decode inline `data:` payloads (composer
  // attachments), so those keep the "sent with your message" notice.
  const inlineOnly = Platform.OS !== "web" && url.startsWith("data:")

  const renderUnavailable = (message: string) => (
    <View className="items-center justify-center gap-3 p-8">
      <VideoIcon size={40} className={isPhone ? "text-white" : "text-muted-foreground"} />
      <Text className={cn("text-center text-sm", isPhone ? "text-white" : "text-muted-foreground")}>
        {message}
      </Text>
    </View>
  )

  const renderNativeVideo = (w: number, h: number) =>
    inlineOnly ? (
      renderUnavailable(
        "Video preview is not available for this attachment on this device.\nIt will be sent with your message.",
      )
    ) : failed ? (
      renderUnavailable("Could not play this video.")
    ) : (
      <Suspense fallback={<ActivityIndicator size="large" />}>
        <NativeVideoView url={url} width={w} height={h} onError={handleVideoError} />
      </Suspense>
    )

  return (
    <Modal isOpen={visible} onClose={onClose} size="full">
      <ModalBackdrop />
      <ModalContent
        className={cn(
          "bg-background overflow-hidden border border-border p-0",
          isPhone ? "m-0 h-full w-full rounded-none" : "m-4 rounded-xl",
        )}
        style={
          isPhone
            ? { width: "100%", height: "100%" }
            : { maxWidth: panelMaxWidth, maxHeight: panelMaxHeight }
        }
      >
        <ModalHeader
          className={cn(
            "flex-row items-center justify-between border-b border-border px-4 py-3",
            isPhone && "bg-black border-white/10",
          )}
          style={isPhone ? { paddingTop: insets.top + 8 } : undefined}
        >
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <VideoIcon size={15} className={isPhone ? "text-white" : "text-muted-foreground"} />
            <Text
              className={cn("text-sm font-semibold", isPhone ? "text-white" : "text-foreground")}
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
          <ModalCloseButton
            className={cn(
              "items-center justify-center",
              isPhone ? "h-11 w-11 rounded-full bg-white/15" : "h-8 w-8 rounded-md",
            )}
            accessibilityLabel="Close video preview"
          >
            <X size={isPhone ? 20 : 16} className={isPhone ? "text-white" : "text-muted-foreground"} />
          </ModalCloseButton>
        </ModalHeader>

        <BodyComponent className="m-0 p-0" style={isPhone ? { flex: 1 } : undefined}>
          <View
            className="items-center justify-center bg-black"
            style={isPhone ? { flex: 1, width: "100%" } : { height: videoHeight, width: "100%" }}
            onLayout={
              isPhone
                ? (event) => {
                    const { width: w, height: h } = event.nativeEvent.layout
                    setPhoneArea((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
                  }
                : undefined
            }
          >
            {Platform.OS === "web" ? (
              <WebVideo
                src={videoSrc}
                controls
                autoPlay
                style={{
                  width: "100%",
                  height: videoHeight,
                  objectFit: "contain",
                  outline: "none",
                }}
              />
            ) : isPhone ? (
              phoneArea ? renderNativeVideo(phoneArea.w, phoneArea.h) : null
            ) : (
              renderNativeVideo(panelMaxWidth, videoHeight)
            )}
          </View>
        </BodyComponent>
      </ModalContent>
    </Modal>
  )
}

export default VideoPreviewModal

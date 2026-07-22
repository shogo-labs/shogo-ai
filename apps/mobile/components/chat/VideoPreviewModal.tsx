// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VideoPreviewModal
 *
 * Inline video player shown when the user taps a video attachment thumbnail
 * in the chat composer. On web/desktop we render a native <video> element;
 * on iOS/Android we show a fallback (no expo-video dependency required).
 */

import React, { useEffect, useMemo } from "react"
import { Platform, Text, useWindowDimensions, View } from "react-native"
import { VideoIcon, X } from "lucide-react-native"
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
} from "@/components/ui/modal"

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

  return (
    <Modal isOpen={visible} onClose={onClose} size="full">
      <ModalBackdrop />
      <ModalContent
        className="bg-background m-4 overflow-hidden rounded-xl border border-border p-0"
        style={{ maxWidth: panelMaxWidth, maxHeight: panelMaxHeight }}
      >
        <ModalHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <VideoIcon size={15} className="text-muted-foreground" />
            <Text
              className="text-sm font-semibold text-foreground"
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
          <ModalCloseButton className="h-8 w-8 items-center justify-center rounded-md">
            <X size={16} className="text-muted-foreground" />
          </ModalCloseButton>
        </ModalHeader>

        <ModalBody className="m-0 p-0">
          <View
            className="items-center justify-center bg-black"
            style={{ height: videoHeight, width: "100%" }}
          >
            {Platform.OS === "web" ? (
              // @ts-ignore — React Native Web passes through HTML video props
              React.createElement("video", {
                src: videoSrc,
                controls: true,
                autoPlay: true,
                style: {
                  width: "100%",
                  height: videoHeight,
                  objectFit: "contain",
                  outline: "none",
                },
              })
            ) : (
              <View className="items-center justify-center gap-3 p-8">
                <VideoIcon size={40} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground text-center">
                  Video preview is not available on this platform.{"\n"}
                  The video has been attached and will be sent with your message.
                </Text>
              </View>
            )}
          </View>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

export default VideoPreviewModal

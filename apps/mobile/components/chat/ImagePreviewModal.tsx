// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ImagePreviewModal
 *
 * Full-size chat image viewer with clipboard support. On web/desktop we copy
 * an actual PNG image blob when the platform clipboard supports it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native"
import { Check, ImageIcon, X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
} from "@/components/ui/modal"
import {
  type CopyState,
  copyImageToClipboard,
  isShogoDesktop,
} from "./chatImageActions"

export interface ImagePreviewModalProps {
  visible: boolean
  onClose: () => void
  url: string
  mediaType?: string
  title?: string
  alt?: string
}

// The image right-click menu only exists in the Shogo desktop app. On web we
// leave right-click to the browser's native context menu.
export function ChatImageContextMenu({
  x,
  y,
  onDownload,
  onClose,
}: {
  x: number
  y: number
  onDownload: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (Platform.OS !== "web") return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("blur", onClose)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("blur", onClose)
    }
  }, [onClose])

  if (!isShogoDesktop() || typeof window === "undefined") return null

  const left = Math.max(8, Math.min(x, window.innerWidth - 220))
  const top = Math.max(8, Math.min(y, window.innerHeight - 78))

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top }}
      className="fixed z-50 min-w-[200px] rounded-xl border border-border bg-background/95 p-1.5 shadow-2xl backdrop-blur"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDownload()
          onClose()
        }}
        className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-foreground hover:bg-primary hover:text-primary-foreground"
      >
        Download Image
      </button>
    </div>
  )
}

export function ImagePreviewModal({
  visible,
  onClose,
  url,
  mediaType,
  title = "Image preview",
  alt = "Image attachment",
}: ImagePreviewModalProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  )
  const resetCopyStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const { width, height } = useWindowDimensions()
  const showCopy = !isShogoDesktop()

  const panelMaxWidth = Math.min(Math.max(width - 32, 280), 960)
  const panelMaxHeight = Math.min(Math.max(height * 0.86, 320), 760)
  const imageMaxHeight = Math.max(240, panelMaxHeight - 112)

  useEffect(() => {
    return () => {
      if (resetCopyStateTimerRef.current) {
        clearTimeout(resetCopyStateTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    if (resetCopyStateTimerRef.current) {
      clearTimeout(resetCopyStateTimerRef.current)
      resetCopyStateTimerRef.current = null
    }
    setCopyState("idle")
    setLoadState("loading")
  }, [visible, url])

  const statusLabel = useMemo(() => {
    switch (copyState) {
      case "copying":
        return "Copying..."
      case "copied":
        return "Copied image"
      case "failed":
        return "Copy failed"
      default:
        return "Copy image"
    }
  }, [copyState])

  const handleCopy = useCallback(async () => {
    if (!url || copyState === "copying") return
    setCopyState("copying")
    const result = await copyImageToClipboard(url, mediaType)
    setCopyState(result)
    if (resetCopyStateTimerRef.current) {
      clearTimeout(resetCopyStateTimerRef.current)
    }
    resetCopyStateTimerRef.current = setTimeout(() => {
      setCopyState("idle")
      resetCopyStateTimerRef.current = null
    }, 2200)
  }, [copyState, mediaType, url])

  return (
    <Modal isOpen={visible} onClose={onClose} size="full">
      <ModalBackdrop />
      <ModalContent
        className="bg-background m-4 overflow-hidden rounded-xl border border-border p-0"
        style={{ maxWidth: panelMaxWidth, maxHeight: panelMaxHeight }}
      >
        <ModalHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <ImageIcon size={15} className="text-muted-foreground" />
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {title}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {showCopy ? (
              <Pressable
                onPress={handleCopy}
                disabled={copyState === "copying"}
                accessibilityRole="button"
                accessibilityLabel={statusLabel}
                className={cn(
                  "h-8 flex-row items-center gap-1.5 rounded-md px-2.5",
                  Platform.OS === "web" && "hover:bg-muted/60",
                  copyState === "failed" && "bg-destructive/10",
                )}
              >
                {copyState === "copying" ? (
                  <ActivityIndicator size="small" />
                ) : copyState === "copied" ? (
                  <Check size={16} className="text-green-500" />
                ) : null}
                <Text
                  className={cn(
                    "text-xs font-medium",
                    copyState === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {statusLabel}
                </Text>
              </Pressable>
            ) : null}
            <ModalCloseButton className="h-8 w-8 items-center justify-center rounded-md">
              <X size={16} className="text-muted-foreground" />
            </ModalCloseButton>
          </View>
        </ModalHeader>

        <ModalBody className="m-0 p-0">
          <View
            className="items-center justify-center bg-muted/20 p-3"
            style={{ maxHeight: imageMaxHeight }}
          >
            {loadState === "loading" ? (
              <View className="absolute inset-0 items-center justify-center">
                <ActivityIndicator size="large" />
              </View>
            ) : null}
            {loadState === "failed" ? (
              <View className="items-center justify-center gap-2 rounded-lg border border-border bg-background p-8">
                <ImageIcon size={28} className="text-muted-foreground" />
                <Text className="text-sm font-medium text-foreground">
                  Could not load this image
                </Text>
                <Text className="max-w-[320px] text-center text-xs text-muted-foreground">
                  The original may have moved or the browser blocked access.
                </Text>
              </View>
            ) : (
              <Image
                source={{ uri: url }}
                resizeMode="contain"
                accessibilityLabel={alt}
                onLoad={() => setLoadState("loaded")}
                onError={() => setLoadState("failed")}
                style={{
                  width: panelMaxWidth - 24,
                  height: imageMaxHeight,
                  opacity: loadState === "loaded" ? 1 : 0,
                }}
              />
            )}
          </View>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

export default ImagePreviewModal

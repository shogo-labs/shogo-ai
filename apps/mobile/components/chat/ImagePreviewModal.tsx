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
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  X,
} from "lucide-react-native"
import {
  PanGestureHandler,
  PinchGestureHandler,
  State,
} from "react-native-gesture-handler"
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
import { useAgentImageSource } from "../../lib/agent-image-source"

export interface ImagePreviewModalProps {
  visible: boolean
  onClose: () => void
  url: string
  gallery?: Array<{ url: string; title?: string; alt?: string }>
  initialIndex?: number
  mediaType?: string
  title?: string
  alt?: string
  onSave?: (url: string) => void | Promise<void>
  onShare?: (url: string) => void | Promise<void>
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

function PinchableImage({
  source,
  width,
  height,
  alt,
  onLoad,
  onError,
  onSwipeDown,
}: {
  source: { uri: string; headers?: Record<string, string> }
  width: number
  height: number
  alt: string
  onLoad: () => void
  onError: () => void
  onSwipeDown: () => void
}) {
  const scale = useRef(new Animated.Value(1)).current
  const pinchScale = useRef(new Animated.Value(1)).current
  const panX = useRef(new Animated.Value(0)).current
  const panY = useRef(new Animated.Value(0)).current
  const baseScale = useRef(1)
  const lastTapAt = useRef(0)

  const handleTap = useCallback(() => {
    const now = Date.now()
    if (now - lastTapAt.current > 280) {
      lastTapAt.current = now
      return
    }
    lastTapAt.current = 0
    baseScale.current = baseScale.current > 1 ? 1 : 2
    Animated.spring(scale, {
      toValue: baseScale.current,
      useNativeDriver: true,
      bounciness: 0,
    }).start()
  }, [scale])

  const pinchEvent = Animated.event([{ nativeEvent: { scale: pinchScale } }], {
    useNativeDriver: true,
  })
  const panEvent = Animated.event(
    [{ nativeEvent: { translationX: panX, translationY: panY } }],
    { useNativeDriver: true },
  )

  const onPinchStateChange = useCallback(
    (event: any) => {
      if (event.nativeEvent.oldState !== State.ACTIVE) return
      baseScale.current = Math.min(
        3,
        Math.max(1, baseScale.current * event.nativeEvent.scale),
      )
      pinchScale.setValue(1)
      Animated.spring(scale, {
        toValue: baseScale.current,
        useNativeDriver: true,
        bounciness: 0,
      }).start()
    },
    [pinchScale, scale],
  )

  const onPanStateChange = useCallback(
    (event: any) => {
      if (event.nativeEvent.oldState !== State.ACTIVE) return
      if (baseScale.current <= 1 && event.nativeEvent.translationY > 120) {
        onSwipeDown()
        panX.setValue(0)
        panY.setValue(0)
        return
      }
      panX.setValue(0)
      panY.setValue(0)
    },
    [onSwipeDown, panX, panY],
  )

  return (
    <Pressable onPress={handleTap} accessibilityLabel="Zoom image">
      <PanGestureHandler
        onGestureEvent={panEvent}
        onHandlerStateChange={onPanStateChange}
      >
        <Animated.View
          style={{ transform: [{ translateX: panX }, { translateY: panY }] }}
        >
          <PinchGestureHandler
            onGestureEvent={pinchEvent}
            onHandlerStateChange={onPinchStateChange}
          >
            <Animated.View>
              <Animated.Image
                source={source}
                resizeMode="contain"
                accessibilityLabel={alt}
                onLoad={onLoad}
                onError={onError}
                style={{
                  width,
                  height,
                  opacity: 1,
                  transform: [{ scale: Animated.multiply(scale, pinchScale) }],
                }}
              />
            </Animated.View>
          </PinchGestureHandler>
        </Animated.View>
      </PanGestureHandler>
    </Pressable>
  )
}

export function ImagePreviewModal({
  visible,
  onClose,
  url,
  gallery,
  initialIndex = 0,
  mediaType,
  title = "Image preview",
  alt = "Image attachment",
  onSave,
  onShare,
}: ImagePreviewModalProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  )
  const [currentIndex, setCurrentIndex] = useState(initialIndex ?? 0)
  const resetCopyStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const { width, height } = useWindowDimensions()
  const showCopy = !isShogoDesktop()
  const activeItem = gallery?.[currentIndex]
  const activeUrl = activeItem?.url ?? url
  const activeTitle = activeItem?.title ?? title
  const activeAlt = activeItem?.alt ?? alt
  const imageSource = useAgentImageSource(activeUrl)
  const isPhone = Platform.OS !== "web" && width < 600
  const hasGallery = !!gallery && gallery.length > 1

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
    setCurrentIndex(initialIndex ?? 0)
  }, [initialIndex, url, visible])

  useEffect(() => {
    if (visible) setLoadState("loading")
  }, [activeUrl, visible])

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
    if (!activeUrl || copyState === "copying") return
    setCopyState("copying")
    const result = await copyImageToClipboard(activeUrl, mediaType)
    setCopyState(result)
    if (resetCopyStateTimerRef.current) {
      clearTimeout(resetCopyStateTimerRef.current)
    }
    resetCopyStateTimerRef.current = setTimeout(() => {
      setCopyState("idle")
      resetCopyStateTimerRef.current = null
    }, 2200)
  }, [activeUrl, copyState, mediaType])

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
        >
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <ImageIcon size={15} className="text-muted-foreground" />
            <Text
              className="text-sm font-semibold text-foreground"
              numberOfLines={1}
            >
              {activeTitle}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {onSave ? (
              <Pressable
                onPress={() => void onSave(activeUrl)}
                className="min-h-11 justify-center rounded-md px-2.5"
                accessibilityRole="button"
                accessibilityLabel="Save image"
              >
                <Text
                  className={cn(
                    "text-xs font-medium",
                    isPhone ? "text-white" : "text-muted-foreground",
                  )}
                >
                  Save
                </Text>
              </Pressable>
            ) : null}
            {onShare ? (
              <Pressable
                onPress={() => void onShare(activeUrl)}
                className="min-h-11 justify-center rounded-md px-2.5"
                accessibilityRole="button"
                accessibilityLabel="Share image"
              >
                <Text
                  className={cn(
                    "text-xs font-medium",
                    isPhone ? "text-white" : "text-muted-foreground",
                  )}
                >
                  Share
                </Text>
              </Pressable>
            ) : null}
            {showCopy ? (
              <Pressable
                onPress={handleCopy}
                disabled={copyState === "copying"}
                accessibilityRole="button"
                accessibilityLabel={statusLabel}
                className={cn(
                  "min-h-11 flex-row items-center gap-1.5 rounded-md px-2.5",
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
                      : isPhone
                        ? "text-white"
                        : "text-muted-foreground",
                  )}
                >
                  {statusLabel}
                </Text>
              </Pressable>
            ) : null}
            <ModalCloseButton className="h-11 w-11 items-center justify-center rounded-md">
              <X
                size={16}
                className={isPhone ? "text-white" : "text-muted-foreground"}
              />
            </ModalCloseButton>
          </View>
        </ModalHeader>

        <ModalBody className="m-0 p-0">
          <View
            className={cn(
              "flex-1 items-center justify-center p-3",
              isPhone && "bg-black",
            )}
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
              <ScrollView
                horizontal
                contentContainerStyle={{
                  minWidth: panelMaxWidth - 24,
                  minHeight: imageMaxHeight,
                  alignItems: "center",
                  justifyContent: "center",
                }}
                maximumZoomScale={Platform.OS === "ios" ? 3 : 1}
                minimumZoomScale={1}
                centerContent
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
              >
                {imageSource ? (
                  isPhone ? (
                    <PinchableImage
                      source={imageSource}
                      width={width - 24}
                      height={imageMaxHeight}
                      alt={activeAlt}
                      onLoad={() => setLoadState("loaded")}
                      onError={() => setLoadState("failed")}
                      onSwipeDown={onClose}
                    />
                  ) : (
                    <Image
                      source={imageSource}
                      resizeMode="contain"
                      accessibilityLabel={activeAlt}
                      onLoad={() => setLoadState("loaded")}
                      onError={() => setLoadState("failed")}
                      style={{
                        width: panelMaxWidth - 24,
                        height: imageMaxHeight,
                        opacity: loadState === "loaded" ? 1 : 0,
                      }}
                    />
                  )
                ) : null}
              </ScrollView>
            )}
            {hasGallery ? (
              <View className="absolute bottom-5 left-0 right-0 flex-row items-center justify-center gap-3">
                <Pressable
                  onPress={() =>
                    setCurrentIndex((index) => Math.max(0, index - 1))
                  }
                  disabled={currentIndex === 0}
                  className={cn(
                    "h-11 w-11 items-center justify-center rounded-full",
                    isPhone ? "bg-white/15" : "bg-background/80",
                    currentIndex === 0 && "opacity-40",
                  )}
                  accessibilityRole="button"
                  accessibilityLabel="Previous generated image"
                >
                  <ChevronLeft
                    size={20}
                    className={isPhone ? "text-white" : "text-foreground"}
                  />
                </Pressable>
                <Text
                  className={cn(
                    "text-xs font-medium",
                    isPhone ? "text-white" : "text-foreground",
                  )}
                >
                  {currentIndex + 1} of {gallery?.length}
                </Text>
                <Pressable
                  onPress={() =>
                    setCurrentIndex((index) =>
                      Math.min((gallery?.length ?? 1) - 1, index + 1),
                    )
                  }
                  disabled={currentIndex === (gallery?.length ?? 1) - 1}
                  className={cn(
                    "h-11 w-11 items-center justify-center rounded-full",
                    isPhone ? "bg-white/15" : "bg-background/80",
                    currentIndex === (gallery?.length ?? 1) - 1 && "opacity-40",
                  )}
                  accessibilityRole="button"
                  accessibilityLabel="Next generated image"
                >
                  <ChevronRight
                    size={20}
                    className={isPhone ? "text-white" : "text-foreground"}
                  />
                </Pressable>
              </View>
            ) : null}
          </View>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

export default ImagePreviewModal

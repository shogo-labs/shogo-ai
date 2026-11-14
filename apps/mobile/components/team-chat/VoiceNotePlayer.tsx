// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A voice note in a message: play/pause, a seekable waveform, elapsed and
 * total time, download, and a speed menu.
 *
 * The waveform is drawn from peaks stored with the attachment, so it appears
 * with the message instead of after the audio loads. Duration comes from the
 * attachment when available, or from audio metadata for older notes.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Modal, Platform, Pressable, Text, View, type GestureResponderEvent } from "react-native"
import { Download, Pause, Play } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { downloadAttachment } from "../../lib/attachment-download"
import {
  PLAYBACK_SPEEDS,
  preloadVoiceNote,
  seekVoiceNote,
  seekVoiceNoteByMs,
  setVoiceNoteSpeed,
  toggleVoiceNote,
  useVoicePlayback,
  type PlaybackSpeed,
} from "../../lib/voice-playback"
import { formatClipDuration, playbackProgress, seekRatioForTap, waveformBars } from "../../lib/voice-note"

export interface VoiceNotePlayerProps {
  attachmentId: string
  url: string
  mimeType?: string | null
  durationMs?: number | null
  peaks?: string | null
  name?: string | null
}

const MENU_WIDTH = 116
const SCRUB_START_PX = 8

function speedLabel(speed: PlaybackSpeed): string {
  return `${speed}x`
}

function playbackUrlForPlatform(url: string, mimeType?: string | null, name?: string | null): string {
  if (Platform.OS !== 'ios') return url
  const mime = (mimeType ?? '').split(';', 1)[0].trim().toLowerCase()
  const unsupportedOnIos = ['audio/webm', 'video/webm', 'audio/ogg', 'application/ogg', 'audio/opus'].includes(mime)
    || /\.(?:webm|ogg|opus)$/i.test(name ?? '')
  if (!unsupportedOnIos) return url

  try {
    const parsed = new URL(url)
    parsed.searchParams.set('playback', 'm4a')
    return parsed.toString()
  } catch {
    const hashIndex = url.indexOf('#')
    const resource = hashIndex === -1 ? url : url.slice(0, hashIndex)
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
    const separator = resource.includes('?') ? '&' : '?'
    return `${resource}${separator}playback=m4a${hash}`
  }
}

export function VoiceNotePlayer({ attachmentId, url, mimeType, durationMs, peaks, name }: VoiceNotePlayerProps) {
  const playback = useVoicePlayback()
  const playbackUrl = playbackUrlForPlatform(url, mimeType, name)
  const playerContainerRef = useRef<View>(null)
  const isActive = playback.activeId === attachmentId
  const isPlaying = isActive && playback.isPlaying
  const isLoading = isActive && playback.isLoading
  const totalMs = playback.durationMs > 0 && isActive ? playback.durationMs : (durationMs ?? 0)
  const progress = isActive ? playbackProgress(playback.positionMs, totalMs) : 0
  const bars = waveformBars(peaks)

  const [menuOpen, setMenuOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number; height: number } | null>(null)
  const speedRef = useRef<View>(null)
  const trackWidthRef = useRef(0)
  const isScrubbingRef = useRef(false)
  const ignorePressRef = useRef(false)
  const gestureStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastLocationXRef = useRef<number | null>(null)

  const label = name?.trim() || "voice note"
  const currentPositionMs = isActive ? playback.positionMs : 0

  useEffect(() => {
    if (Platform.OS !== "web" || typeof IntersectionObserver === "undefined") return
    const node = playerContainerRef.current as unknown as Element | null
    if (!node) return

    let releasePreload: (() => void) | null = null
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        releasePreload ??= preloadVoiceNote(playbackUrl)
      } else {
        releasePreload?.()
        releasePreload = null
      }
    }, { rootMargin: "180px 0px" })

    observer.observe(node)
    return () => {
      observer.disconnect()
      releasePreload?.()
    }
  }, [playbackUrl, isActive])

  const onToggle = useCallback(() => {
    toggleVoiceNote({ id: attachmentId, url: playbackUrl, durationMs })
  }, [attachmentId, playbackUrl, durationMs])

  const seekToLocation = useCallback(
    (locationX: unknown) => {
      const ratio = seekRatioForTap(locationX, trackWidthRef.current)
      if (ratio === null) return
      seekVoiceNote({ id: attachmentId, url: playbackUrl, durationMs }, ratio)
    },
    [attachmentId, playbackUrl, durationMs],
  )

  const onSeek = useCallback((event: GestureResponderEvent) => {
    if (ignorePressRef.current) {
      ignorePressRef.current = false
      return
    }
    if (isScrubbingRef.current) {
      isScrubbingRef.current = false
      return
    }
    // React Native Web sends a MouseEvent for onPress, with no locationX.
    seekToLocation(event.nativeEvent.locationX ?? lastLocationXRef.current)
  }, [seekToLocation])

  const onScrubStart = useCallback((event: GestureResponderEvent) => {
    const { locationX, pageX, pageY } = event.nativeEvent
    isScrubbingRef.current = false
    ignorePressRef.current = false
    lastLocationXRef.current = Number.isFinite(locationX) ? locationX : null
    gestureStartRef.current = Number.isFinite(pageX) && Number.isFinite(pageY)
      ? { x: pageX, y: pageY }
      : null
  }, [])

  const onScrubMove = useCallback((event: GestureResponderEvent) => {
    const start = gestureStartRef.current
    if (!start) return
    const dx = event.nativeEvent.pageX - start.x
    const dy = event.nativeEvent.pageY - start.y
    if (!isScrubbingRef.current) {
      if (Math.abs(dy) >= SCRUB_START_PX && Math.abs(dy) > Math.abs(dx)) {
        ignorePressRef.current = true
      }
      if (ignorePressRef.current) return
      if (Math.abs(dx) < SCRUB_START_PX || Math.abs(dx) <= Math.abs(dy)) return
      isScrubbingRef.current = true
    }
    lastLocationXRef.current = event.nativeEvent.locationX
    seekToLocation(event.nativeEvent.locationX)
  }, [seekToLocation])

  const onScrubEnd = useCallback((event: GestureResponderEvent) => {
    gestureStartRef.current = null
    const locationX = event.nativeEvent.locationX
    if (Number.isFinite(locationX)) {
      if (isScrubbingRef.current && locationX !== lastLocationXRef.current) {
        seekToLocation(locationX)
      }
      lastLocationXRef.current = locationX
    }
  }, [seekToLocation])

  const seekByKeyboard = useCallback((direction: -1 | 1) => {
    seekVoiceNoteByMs({ id: attachmentId, url: playbackUrl, durationMs }, direction * 5_000)
  }, [attachmentId, durationMs, playbackUrl])

  const onSeekAccessibilityAction = useCallback((event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === "increment") seekByKeyboard(1)
    if (event.nativeEvent.actionName === "decrement") seekByKeyboard(-1)
  }, [seekByKeyboard])

  const onSeekKeyDown = useCallback((event: {
    key?: string
    nativeEvent?: { key?: string }
    preventDefault?: () => void
  }) => {
    const key = event.nativeEvent?.key ?? event.key
    if (key === "ArrowRight") {
      event.preventDefault?.()
      seekByKeyboard(1)
    } else if (key === "ArrowLeft") {
      event.preventDefault?.()
      seekByKeyboard(-1)
    }
  }, [seekByKeyboard])

  const webPressProps = Platform.OS === "web"
    ? { onKeyDown: onSeekKeyDown, tabIndex: 0 as const, delayPressIn: 0 }
    : {}

  const onDownload = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadAttachment(url, label)
    } finally {
      setDownloading(false)
    }
  }, [downloading, label, url])

  const openMenu = useCallback(() => {
    // Anchor the popover to the button; fall back to centred if unmeasurable.
    ;(speedRef.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void })
      ?.measureInWindow?.((x, y, _w, h) => setAnchor({ x, y, height: h }))
    setMenuOpen(true)
  }, [])

  const chooseSpeed = useCallback((speed: PlaybackSpeed) => {
    setVoiceNoteSpeed(speed)
    setMenuOpen(false)
  }, [])

  return (
    <View
      ref={playerContainerRef}
      className="rounded-2xl border border-border bg-card px-3 py-2"
      style={{ minWidth: 252, maxWidth: 360 }}
    >
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={isLoading ? `Loading ${label}` : isPlaying ? `Pause ${label}` : `Play ${label}`}
          accessibilityState={{ busy: isLoading }}
          className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80"
        >
          {isLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : isPlaying ? (
            <Pause size={15} className="text-primary-foreground" />
          ) : (
            <Play size={15} className="text-primary-foreground" />
          )}
        </Pressable>

        <Pressable
          onPress={onSeek}
          onPressIn={onScrubStart}
          onPressMove={onScrubMove}
          onPressOut={onScrubEnd}
          onLayout={(event) => {
            trackWidthRef.current = Math.round(event.nativeEvent.layout.width)
          }}
          onAccessibilityAction={onSeekAccessibilityAction}
          accessibilityActions={[
            { name: "increment", label: "Seek forward five seconds" },
            { name: "decrement", label: "Seek backward five seconds" },
          ]}
          accessibilityValue={{ min: 0, max: Math.max(1, totalMs), now: Math.min(currentPositionMs, totalMs) }}
          accessibilityRole="adjustable"
          accessibilityLabel={`Seek ${label}`}
          {...webPressProps}
          className="min-w-0 flex-1 justify-center"
          style={{ height: 30 }}
        >
          <View className="flex-row items-center" style={{ gap: 2, height: 30 }} pointerEvents="none">
            {bars.map((level, index) => {
              const played = progress > 0 && index / bars.length < progress
              return (
                <View
                  key={index}
                  className={cn("flex-1 rounded-full", played ? "bg-primary" : "bg-muted-foreground/40")}
                  style={{ height: Math.max(3, Math.round((level / 100) * 26)) }}
                />
              )
            })}
          </View>
        </Pressable>

        <Pressable
          onPress={() => void onDownload()}
          disabled={downloading}
          accessibilityRole="button"
          accessibilityLabel={`Download ${label}`}
          className="h-8 w-7 items-center justify-center rounded-md active:bg-muted"
        >
          <Download size={16} className="text-muted-foreground" />
        </Pressable>

        <View ref={speedRef} collapsable={false}>
          <Pressable
            onPress={openMenu}
            accessibilityRole="button"
            accessibilityLabel={`Playback speed ${speedLabel(playback.rate)}`}
            className="rounded-md px-1.5 py-0.5 active:bg-muted"
          >
            <Text className="text-[11px] font-medium text-muted-foreground">{speedLabel(playback.rate)}</Text>
          </Pressable>
        </View>
      </View>

      <View className="mt-1 flex-row justify-between pl-12">
        <Text className="text-[11px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {formatClipDuration(currentPositionMs)}
        </Text>
        <Text className="text-[11px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {totalMs > 0 ? formatClipDuration(totalMs) : "--:--"}
        </Text>
      </View>

      {isActive && playback.error ? (
        <Text className="mt-1 pl-12 text-[11px] text-destructive" accessibilityRole="alert">
          {playback.error}
        </Text>
      ) : null}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable className="flex-1" accessibilityLabel="Close playback speed" onPress={() => setMenuOpen(false)}>
          <View
            className="absolute rounded-xl border border-border bg-card py-1"
            style={{
              width: MENU_WIDTH,
              top: anchor ? anchor.y + anchor.height + 6 : 120,
              left: anchor ? Math.max(8, anchor.x - MENU_WIDTH + 40) : 24,
            }}
          >
            {PLAYBACK_SPEEDS.map((speed) => (
              <Pressable
                key={speed}
                onPress={() => chooseSpeed(speed)}
                accessibilityRole="button"
                accessibilityLabel={`Play at ${speedLabel(speed)}`}
                className={cn(
                  "px-3 py-2 active:bg-muted",
                  playback.rate === speed ? "bg-primary/10" : undefined,
                )}
              >
                <Text
                  className={cn(
                    "text-xs",
                    playback.rate === speed ? "font-semibold text-primary" : "text-foreground",
                  )}
                >
                  {speedLabel(speed)}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A voice note in a message: play/pause, a waveform you can scrub, how long
 * the clip is, and a speed menu.
 *
 * The waveform is drawn from peaks stored with the attachment, so it appears
 * with the message instead of after the audio loads, and the total duration
 * comes from the attachment too — nothing here waits on a network round trip.
 */

import { useCallback, useRef, useState } from "react"
import { Modal, Pressable, Text, View } from "react-native"
import { Pause, Play } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  PLAYBACK_SPEEDS,
  seekVoiceNote,
  setVoiceNoteSpeed,
  toggleVoiceNote,
  useVoicePlayback,
  type PlaybackSpeed,
} from "../../lib/voice-playback"
import { formatClipDuration, playbackProgress, seekRatioForTap, waveformBars } from "../../lib/voice-note"

export interface VoiceNotePlayerProps {
  attachmentId: string
  url: string
  durationMs?: number | null
  peaks?: string | null
  name?: string | null
}

const MENU_WIDTH = 116

function speedLabel(speed: PlaybackSpeed): string {
  return `${speed}x`
}

export function VoiceNotePlayer({ attachmentId, url, durationMs, peaks, name }: VoiceNotePlayerProps) {
  const playback = useVoicePlayback()
  const isActive = playback.activeId === attachmentId
  const isPlaying = isActive && playback.isPlaying
  const totalMs = playback.durationMs > 0 && isActive ? playback.durationMs : (durationMs ?? 0)
  const progress = isActive ? playbackProgress(playback.positionMs, totalMs) : 0
  const bars = waveformBars(peaks)

  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number; height: number } | null>(null)
  const speedRef = useRef<View>(null)
  const trackWidthRef = useRef(0)

  const label = name?.trim() || "voice note"

  const onToggle = useCallback(() => {
    toggleVoiceNote({ id: attachmentId, url, durationMs })
  }, [attachmentId, url, durationMs])

  const onSeek = useCallback(
    (event: { nativeEvent?: { locationX?: number } }) => {
      const ratio = seekRatioForTap(event?.nativeEvent?.locationX, trackWidthRef.current)
      if (ratio === null) return
      seekVoiceNote({ id: attachmentId, url, durationMs }, ratio)
    },
    [attachmentId, url, durationMs],
  )

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
      className="flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-2"
      style={{ minWidth: 236, maxWidth: 340 }}
    >
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? `Pause ${label}` : `Play ${label}`}
        className="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80"
      >
        {isPlaying ? (
          <Pause size={15} className="text-primary-foreground" />
        ) : (
          <Play size={15} className="text-primary-foreground" />
        )}
      </Pressable>

      <Pressable
        onPress={onSeek}
        onLayout={(event) => {
          trackWidthRef.current = Math.round(event.nativeEvent.layout.width)
        }}
        accessibilityRole="adjustable"
        accessibilityLabel={`Seek ${label}`}
        className="flex-1 justify-center"
        style={{ height: 30 }}
      >
        <View className="flex-row items-center" style={{ gap: 2, height: 30 }}>
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

      <Text className="text-[11px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
        {formatClipDuration(isActive && playback.positionMs > 0 ? playback.positionMs : totalMs)}
      </Text>

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

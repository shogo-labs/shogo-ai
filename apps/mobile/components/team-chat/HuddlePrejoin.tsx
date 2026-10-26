// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The green room for channel huddles: see your camera, watch the mic level,
 * pick devices, and choose to join muted or with the camera off. Answering a
 * 1:1 ring never comes here; it stays one tap.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, Text, View } from 'react-native'
import { Mic, MicOff, Settings, Video, VideoOff } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { cancelPendingHuddleJoin, joinHuddleCall, type PendingHuddleJoin } from '../../lib/huddle-call'
import { useHuddlePrefs } from '../../lib/huddle-prefs'
import { HuddleNotesNotice } from './HuddleNotesPill'
import { openPreview, previewSupported, type Preview } from '../../lib/huddle-preview'
import { HuddleSettingsSheet } from './HuddleSettingsSheet'

function MeterBar({ preview, active }: { preview: Preview | null; active: boolean }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!preview || !active) {
      setLevel(0)
      return
    }
    const id = setInterval(() => setLevel(preview.level()), 80)
    return () => clearInterval(id)
  }, [preview, active])
  return (
    <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" accessibilityLabel="Microphone level" testID="huddle-prejoin-meter">
      <View className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(level * 100)}%` }} />
    </View>
  )
}

export function HuddlePrejoin({ pending }: { pending: PendingHuddleJoin }) {
  const prefs = useHuddlePrefs()
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [settings, setSettings] = useState(false)
  const [denied, setDenied] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const web = Platform.OS === 'web' && previewSupported

  // Open the camera (and mic, for the meter) while the preview is up.
  useEffect(() => {
    if (!web || (!cameraOn && !micOn)) {
      setPreview(null)
      return
    }
    let live: Preview | null = null
    let cancelled = false
    void openPreview({ cameraId: prefs.cameraId, micId: prefs.micId, video: cameraOn, audio: micOn }).then((p) => {
      if (cancelled) {
        p?.stop()
        return
      }
      live = p
      setPreview(p)
      setDenied(!p && (cameraOn || micOn))
    })
    return () => {
      cancelled = true
      live?.stop()
    }
  }, [web, cameraOn, micOn, prefs.cameraId, prefs.micId, settings])

  useEffect(() => {
    const el = videoRef.current
    if (el) el.srcObject = cameraOn ? (preview?.stream ?? null) : null
  }, [preview, cameraOn])

  const join = () => {
    preview?.stop()
    setPreview(null)
    void joinHuddleCall({
      conversationId: pending.conversationId,
      workspaceId: pending.workspaceId,
      label: pending.label,
      kind: pending.kind,
      startMuted: !micOn,
      startCamera: cameraOn,
    })
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cancelPendingHuddleJoin}>
      <Pressable className="flex-1 items-center justify-center bg-black/50 p-6" onPress={cancelPendingHuddleJoin}>
        <Pressable className="w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}} testID="huddle-prejoin">
          <Text className="text-base font-semibold text-foreground">Join huddle in {pending.label}</Text>
          <Text className="mb-3 text-xs text-muted-foreground">Check your camera and mic before you join.</Text>

          <View className="mb-3 aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-zinc-900" testID="huddle-prejoin-preview">
            {web && cameraOn && preview?.stream.getVideoTracks().length
              ? createElement('video', {
                  ref: videoRef,
                  autoPlay: true,
                  playsInline: true,
                  muted: true,
                  style: { width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' },
                })
              : (
                <Text className="px-4 text-center text-sm text-zinc-400">
                  {denied ? 'Shogo can’t reach your camera or mic. Check your browser permissions.' : cameraOn ? 'Starting camera…' : 'Camera is off'}
                </Text>
              )}
          </View>

          <View className="mb-4 flex-row items-center gap-3">
            <Pressable
              onPress={() => setMicOn((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: micOn }}
              accessibilityLabel={micOn ? 'Join with microphone on' : 'Join muted'}
              className={cn('h-10 w-10 items-center justify-center rounded-full', micOn ? 'bg-muted' : 'bg-destructive')}
            >
              {micOn ? <Mic size={18} className="text-foreground" /> : <MicOff size={18} color="white" />}
            </Pressable>
            <Pressable
              onPress={() => setCameraOn((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: cameraOn }}
              accessibilityLabel={cameraOn ? 'Join with camera on' : 'Join with camera off'}
              className={cn('h-10 w-10 items-center justify-center rounded-full', cameraOn ? 'bg-emerald-600' : 'bg-muted')}
            >
              {cameraOn ? <Video size={18} color="white" /> : <VideoOff size={18} className="text-foreground" />}
            </Pressable>
            <MeterBar preview={preview} active={micOn} />
            <Pressable onPress={() => setSettings(true)} accessibilityRole="button" accessibilityLabel="Device and camera settings" className="h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Settings size={18} className="text-foreground" />
            </Pressable>
          </View>

          <View className="mb-3">
            <HuddleNotesNotice />
          </View>

          <View className="flex-row gap-2">
            <Pressable onPress={cancelPendingHuddleJoin} accessibilityRole="button" accessibilityLabel="Cancel" className="flex-1 items-center rounded-md border border-border py-3 active:bg-muted">
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable onPress={join} accessibilityRole="button" accessibilityLabel="Join huddle" className="flex-1 items-center rounded-md bg-emerald-600 py-3 active:opacity-80">
              <Text className="text-sm font-medium text-white">Join</Text>
            </Pressable>
          </View>
          {settings ? <HuddleSettingsSheet inCall={false} conversationId={pending.conversationId} onClose={() => setSettings(false)} /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

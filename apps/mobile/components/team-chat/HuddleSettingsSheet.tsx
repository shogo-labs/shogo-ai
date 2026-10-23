// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle settings: mic, camera and speaker pickers, background blur or
 * replacement, auto-framing, and low-light adjustment. Choices are remembered
 * on this device. Works during a call (switches live) and before one (the
 * pre-join preview), where it lists devices straight from the browser.
 */
import { createElement, useCallback, useEffect, useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native'
import { Check, ImagePlus, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  listHuddleDevices,
  onHuddleDevicesChanged,
  setHuddleAutoFraming,
  setHuddleBackground,
  setHuddleLowLight,
  switchHuddleDevice,
  type HuddleDevice,
  type HuddleDeviceKind,
} from '../../lib/huddle-call'
import { BUILT_IN_BACKGROUNDS, setHuddlePrefs, useHuddlePrefs, type BackgroundEffect } from '../../lib/huddle-prefs'
import { imageToBackgroundDataUrl, listLocalDevices, onLocalDevicesChanged, playTestTone } from '../../lib/huddle-preview'
import { teamChatApi } from '../../lib/team-chat-api'

const effectsAvailable = Platform.OS === 'web'

function sameBackground(a: BackgroundEffect, b: BackgroundEffect): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'blur' && b.kind === 'blur') return a.radius === b.radius
  if (a.kind === 'image' && b.kind === 'image') return a.url === b.url
  return true
}

function DeviceSection({ title, kind, inCall, selected, onSelect }: { title: string; kind: HuddleDeviceKind; inCall: boolean; selected: string | null; onSelect: (id: string) => void }) {
  const [devices, setDevices] = useState<HuddleDevice[]>([])
  const load = useCallback(async () => {
    setDevices(inCall ? await listHuddleDevices(kind) : await listLocalDevices(kind))
  }, [inCall, kind])

  useEffect(() => {
    void load()
    return inCall ? onHuddleDevicesChanged(() => void load()) : onLocalDevicesChanged(() => void load())
  }, [load, inCall])

  if (!devices.length) return null
  const active = selected && devices.some((d) => d.id === selected) ? selected : devices[0].id
  return (
    <View className="mb-4" testID={`huddle-devices-${kind}`}>
      <View className="mb-1 flex-row items-center">
        <Text className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</Text>
        {kind === 'audiooutput' ? (
          <Pressable onPress={() => void playTestTone(active)} accessibilityRole="button" accessibilityLabel="Test speaker">
            <Text className="text-xs font-medium text-primary">Test</Text>
          </Pressable>
        ) : null}
      </View>
      {devices.map((d) => (
        <Pressable
          key={d.id}
          accessibilityRole="radio"
          accessibilityState={{ selected: d.id === active }}
          accessibilityLabel={d.label}
          onPress={() => onSelect(d.id)}
          className="min-h-10 flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
        >
          <View className="w-4">{d.id === active ? <Check size={14} className="text-emerald-600" /> : null}</View>
          <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{d.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function Swatch({ label, selected, onPress, children }: { label: string; selected: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      className={cn('h-14 w-20 items-center justify-center overflow-hidden rounded-lg border-2', selected ? 'border-emerald-500' : 'border-border')}
    >
      {children}
    </Pressable>
  )
}

export function HuddleSettingsSheet({
  inCall,
  conversationId,
  onClose,
}: {
  inCall: boolean
  /** Where a custom background is stored; the huddle's conversation. */
  conversationId: string | null
  onClose: () => void
}) {
  const prefs = useHuddlePrefs()
  const [error, setError] = useState<string | null>(null)

  const pick = (kind: HuddleDeviceKind) => (id: string) => {
    if (inCall) void switchHuddleDevice(kind, id)
    else setHuddlePrefs({ [kind === 'audioinput' ? 'micId' : kind === 'videoinput' ? 'cameraId' : 'speakerId']: id })
  }
  const setBackground = (bg: BackgroundEffect) => {
    if (inCall) setHuddleBackground(bg)
    else setHuddlePrefs({ background: bg })
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      if (!file.type.startsWith('image/')) throw new Error('Pick an image file')
      const url = await imageToBackgroundDataUrl(file)
      // Keep a copy with the conversation's files; the call uses the small local copy so it loads instantly.
      if (conversationId) void teamChatApi().upload(conversationId, file).catch(() => {})
      setBackground({ kind: 'image', url, name: file.name.replace(/\.[^.]+$/, '') || 'Custom' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not use that image')
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[85%] w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}} testID="huddle-settings">
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">Huddle settings</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close settings">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <DeviceSection title="Microphone" kind="audioinput" inCall={inCall} selected={prefs.micId} onSelect={pick('audioinput')} />
            <DeviceSection title="Camera" kind="videoinput" inCall={inCall} selected={prefs.cameraId} onSelect={pick('videoinput')} />
            <DeviceSection title="Speaker" kind="audiooutput" inCall={inCall} selected={prefs.speakerId} onSelect={pick('audiooutput')} />

            {effectsAvailable ? (
              <View className="mb-4" testID="huddle-backgrounds">
                <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Background</Text>
                <View className="flex-row flex-wrap gap-2">
                  <Swatch label="No background effect" selected={sameBackground(prefs.background, { kind: 'none' })} onPress={() => setBackground({ kind: 'none' })}>
                    <Text className="text-xs text-foreground">None</Text>
                  </Swatch>
                  <Swatch label="Light blur" selected={sameBackground(prefs.background, { kind: 'blur', radius: 8 })} onPress={() => setBackground({ kind: 'blur', radius: 8 })}>
                    <Text className="text-xs text-foreground">Blur</Text>
                  </Swatch>
                  <Swatch label="Strong blur" selected={sameBackground(prefs.background, { kind: 'blur', radius: 24 })} onPress={() => setBackground({ kind: 'blur', radius: 24 })}>
                    <Text className="text-xs text-foreground">More blur</Text>
                  </Swatch>
                  {BUILT_IN_BACKGROUNDS.map((bg) => (
                    <Swatch
                      key={bg.id}
                      label={`${bg.name} background`}
                      selected={prefs.background.kind === 'image' && prefs.background.url === bg.url}
                      onPress={() => setBackground({ kind: 'image', url: bg.url, name: bg.name })}
                    >
                      {createElement('img', { src: bg.url, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })}
                    </Swatch>
                  ))}
                  {prefs.background.kind === 'image' && !BUILT_IN_BACKGROUNDS.some((b) => b.url === (prefs.background as { url: string }).url) ? (
                    <Swatch label={`${prefs.background.name} background`} selected onPress={() => {}}>
                      {createElement('img', { src: prefs.background.url, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })}
                    </Swatch>
                  ) : null}
                  {createElement(
                    'label',
                    { style: { cursor: 'pointer' }, 'aria-label': 'Upload a background image' },
                    <View className="h-14 w-20 items-center justify-center rounded-lg border-2 border-dashed border-border">
                      <ImagePlus size={18} className="text-muted-foreground" />
                    </View>,
                    createElement('input', {
                      type: 'file',
                      accept: 'image/*',
                      style: { display: 'none' },
                      'data-testid': 'huddle-background-upload',
                      onChange: (e: { target: { files: FileList | null; value: string } }) => {
                        void onFile(e.target.files?.[0])
                        e.target.value = ''
                      },
                    }),
                  )}
                </View>
              </View>
            ) : null}

            {effectsAvailable ? (
              <View className="mb-2 gap-3">
                <ToggleRow
                  label="Auto-framing"
                  hint="Keeps your face centered as you move"
                  value={prefs.autoFraming}
                  onChange={(v) => (inCall ? setHuddleAutoFraming(v) : setHuddlePrefs({ autoFraming: v }))}
                />
                <ToggleRow
                  label="Low-light adjustment"
                  hint="Brightens your video when the room is dark"
                  value={prefs.lowLight}
                  onChange={(v) => (inCall ? setHuddleLowLight(v) : setHuddlePrefs({ lowLight: v }))}
                />
              </View>
            ) : null}
            <ToggleRow
              label="Preview before joining channel huddles"
              hint="Check your camera and mic first"
              value={prefs.previewBeforeJoin}
              onChange={(v) => setHuddlePrefs({ previewBeforeJoin: v })}
            />
            {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function ToggleRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View className="mb-2 flex-row items-center gap-3">
      <View className="flex-1">
        <Text className="text-sm text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  )
}

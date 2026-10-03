// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Mic } from 'lucide-react-native'
import type { DictationShortcutConfig, PermissionStatus } from '../../../lib/desktop-bridge'
import { HANDS_FREE_OPTIONS, PUSH_TO_TALK_OPTIONS } from '../../../lib/local-access'
import { useOsPermissions } from '../../../lib/use-os-permissions'
import { OptionSelect } from './OptionSelect'
import { PermissionRow } from './PermissionRow'

interface DictationStepProps {
  value: DictationShortcutConfig
  onChange: (next: DictationShortcutConfig) => void
  onStatusChange?: (status: PermissionStatus) => void
}

/** Microphone access, then (once granted) the push-to-talk and hands-free shortcuts. */
export function DictationStep({ value, onChange, onStatusChange }: DictationStepProps) {
  const perms = useOsPermissions()
  const { status, requesting } = perms

  useEffect(() => {
    if (perms.ready) onStatusChange?.(status)
  }, [status, perms.ready, onStatusChange])

  const micGranted = status.mic === 'granted'
  const fnNeedsAccessibility =
    value.pushToTalk === 'Fn' && status.accessibility !== 'granted' && status.accessibility !== 'unsupported'

  return (
    <View className="gap-4">
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        <PermissionRow
          id="mic"
          title="Microphone"
          description={micGranted ? undefined : 'Allow Shogo to hear you when you dictate'}
          icon={Mic}
          state={status.mic}
          busy={requesting === 'mic'}
          onAllow={() => void perms.request('mic')}
        />
      </View>

      {micGranted ? (
        <View testID="dictation-shortcuts" className="gap-2">
          <Text className="px-1 text-xs font-medium text-muted-foreground">Shortcuts</Text>
          <View className="rounded-2xl border border-border bg-card">
            <View className="flex-row items-start justify-between gap-4 px-5 py-4">
              <View className="min-w-0 flex-1">
                <Text className="text-base font-semibold text-foreground">Push to talk</Text>
                <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">Hold the key to dictate</Text>
              </View>
              <OptionSelect<string | null>
                testID="dictation-push-to-talk"
                label="Push to talk"
                value={value.pushToTalk}
                options={PUSH_TO_TALK_OPTIONS}
                onChange={(pushToTalk) => onChange({ ...value, pushToTalk })}
              />
            </View>
            <View className="h-px bg-border" />
            <View className="flex-row items-start justify-between gap-4 px-5 py-4">
              <View className="min-w-0 flex-1">
                <Text className="text-base font-semibold text-foreground">Hands-free mode</Text>
                <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">
                  Press the key to start and stop dictation without holding
                </Text>
              </View>
              <OptionSelect<string | null>
                testID="dictation-hands-free"
                label="Hands-free mode"
                value={value.handsFree}
                options={HANDS_FREE_OPTIONS}
                onChange={(handsFree) => onChange({ ...value, handsFree })}
              />
            </View>
          </View>
          {value.pushToTalk === 'Fn' ? (
            <Text className="px-1 text-xs leading-4 text-muted-foreground">
              If the Globe key opens the emoji picker or system dictation, set "Press Globe key to" to "Do Nothing" in
              System Settings &gt; Keyboard.
            </Text>
          ) : null}
          {fnNeedsAccessibility ? (
            <View className="flex-row flex-wrap items-center gap-x-2 px-1">
              <Text className="text-xs leading-4 text-muted-foreground">
                The Fn key needs Accessibility access to work outside Shogo.
              </Text>
              <Pressable
                testID="dictation-allow-accessibility"
                accessibilityRole="button"
                onPress={() => void perms.request('accessibility')}
              >
                <Text className="text-xs font-medium text-primary">Allow</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Mic, MicOff, ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { createHttpClient } from '../../../lib/api'

type MeetingPreset = 'enabled' | 'manual' | 'disabled'

interface MeetingSetupFormProps {
  onComplete: () => void
}

const PRESETS: { id: MeetingPreset; icon: typeof Mic; title: string; desc: string }[] = [
  {
    id: 'enabled',
    icon: Mic,
    title: 'Auto-detect & record',
    desc: 'Shogo detects meetings via mic activity and asks to record. Transcripts are fully local.',
  },
  {
    id: 'manual',
    icon: Mic,
    title: 'Manual only',
    desc: 'Recording is available but never starts automatically. Use the menu bar icon or Meetings page.',
  },
  {
    id: 'disabled',
    icon: MicOff,
    title: 'Disabled',
    desc: 'Meeting recording is off. You can enable it later in Settings.',
  },
]

export function MeetingSetupForm({ onComplete }: MeetingSetupFormProps) {
  const [selected, setSelected] = useState<MeetingPreset>('enabled')
  const [isSaving, setIsSaving] = useState(false)
  const http = useMemo(() => createHttpClient(), [])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      const patch = selected === 'enabled'
        ? { autoDetect: true, autoRecord: false }
        : { autoDetect: false, autoRecord: false }
      await http.request('/api/local/meetings/config', { method: 'PUT', body: patch })
    } catch {}
    setIsSaving(false)
    onComplete()
  }, [http, selected, onComplete])

  return (
    <View className="gap-3">
      {PRESETS.map((preset) => {
        const Icon = preset.icon
        const isActive = selected === preset.id
        return (
          <Pressable
            key={preset.id}
            onPress={() => setSelected(preset.id)}
            className={cn(
              'flex-row items-start gap-3 p-3 rounded-xl border',
              isActive ? 'border-primary bg-primary/5' : 'border-border bg-background'
            )}
          >
            <View className={cn(
              'h-8 w-8 rounded-lg items-center justify-center mt-0.5',
              isActive ? 'bg-primary/15' : 'bg-muted'
            )}>
              <Icon size={16} className={isActive ? 'text-primary' : 'text-muted-foreground'} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className={cn(
                'text-sm font-medium',
                isActive ? 'text-primary' : 'text-foreground'
              )}>
                {preset.title}
              </Text>
              <Text className="text-xs text-muted-foreground leading-4">
                {preset.desc}
              </Text>
            </View>
            <View className={cn(
              'h-5 w-5 rounded-full border-2 items-center justify-center mt-1',
              isActive ? 'border-primary' : 'border-border'
            )}>
              {isActive && <View className="h-2.5 w-2.5 rounded-full bg-primary" />}
            </View>
          </Pressable>
        )
      })}

      <Pressable
        onPress={handleSave}
        disabled={isSaving}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3 rounded-xl mt-1',
          isSaving ? 'bg-primary/30' : 'bg-primary'
        )}
      >
        {isSaving ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Text className="text-sm font-semibold text-primary-foreground">Continue</Text>
            <ArrowRight size={16} color="#fff" />
          </>
        )}
      </Pressable>
    </View>
  )
}

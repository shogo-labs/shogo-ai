// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { SecurityPreferenceSelector } from '../../security/SecurityPreferenceSelector'
import { api, createHttpClient } from '../../../lib/api'

interface SecurityFormProps {
  onComplete: () => void
}

export function SecurityForm({ onComplete }: SecurityFormProps) {
  const [securityMode, setSecurityMode] = useState<'strict' | 'balanced' | 'full_autonomy'>('full_autonomy')
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    const http = createHttpClient()
    try {
      await api.saveSecurityPrefs(http, {
        mode: securityMode,
        approvalTimeoutSeconds: 60,
      })
    } catch {}
    setIsSaving(false)
    onComplete()
  }, [securityMode, onComplete])

  return (
    <View className="gap-4">
      <SecurityPreferenceSelector value={securityMode} onChange={setSecurityMode} compact />

      <Pressable
        onPress={handleSave}
        disabled={isSaving}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3 rounded-xl',
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

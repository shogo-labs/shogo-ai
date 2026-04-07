// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native'
import { ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

interface NameInputProps {
  onComplete: (name: string) => void
}

export function NameInput({ onComplete }: NameInputProps) {
  const [name, setName] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim()) return
    setIsSaving(true)
    try {
      await fetch(`${API_URL}/api/auth/update-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim() }),
      })
    } catch {}
    setIsSaving(false)
    onComplete(name.trim())
  }

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-3">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor="#666"
          autoCapitalize="words"
          autoFocus
          onSubmitEditing={handleSubmit}
          className="flex-1 bg-background border border-border rounded-xl px-4 py-3 text-base text-foreground"
        />
        <Pressable
          onPress={handleSubmit}
          disabled={isSaving || !name.trim()}
          className={cn(
            'w-11 h-11 rounded-xl items-center justify-center',
            !name.trim() ? 'bg-primary/30' : 'bg-primary'
          )}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <ArrowRight size={18} color="#fff" />
          )}
        </Pressable>
      </View>
    </View>
  )
}

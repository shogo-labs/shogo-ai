// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Text, View } from 'react-native'
import { Input } from '@shogo/shared-ui/primitives'

interface NameInputProps {
  value: string
  onChange: (name: string) => void
  onSubmit?: () => void
  error?: string | null
}

/** Body of the local onboarding "what should we call you?" step. */
export function NameInput({ value, onChange, onSubmit, error }: NameInputProps) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">Your name</Text>
      <Input
        value={value}
        onChangeText={onChange}
        onSubmitEditing={() => {
          if (value.trim()) onSubmit?.()
        }}
        placeholder="e.g. Alex Kim"
        autoCapitalize="words"
        returnKeyType="next"
        autoFocus={Platform.OS === 'web'}
        className="h-12 rounded-xl px-4 text-base"
      />
      {error ? (
        <Text className="text-sm text-destructive">{error}</Text>
      ) : (
        <Text className="text-xs text-muted-foreground">You can change it later in settings.</Text>
      )}
    </View>
  )
}

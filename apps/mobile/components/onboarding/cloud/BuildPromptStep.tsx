// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Pressable, Text, TextInput, View } from 'react-native'

interface BuildPromptStepProps {
  value: string
  onChange: (value: string) => void
  /** Enter (without Shift) on web submits a non-empty prompt. */
  onSubmit?: () => void
}

const EXAMPLES = [
  'A support agent that answers customer emails',
  'A CRM for tracking my sales pipeline',
  'Launch a subscription coffee business',
  'Turn meeting notes into tasks every Friday',
]

/** Body of the team onboarding "What do you want to build?" step. */
export function BuildPromptStep({ value, onChange, onSubmit }: BuildPromptStepProps) {
  return (
    <View className="gap-4">
      <TextInput
        testID="onboarding-build-prompt-input"
        accessibilityLabel="What do you want to build?"
        value={value}
        onChangeText={onChange}
        onKeyPress={(e) => {
          if (Platform.OS !== 'web') return
          const native = e.nativeEvent as { key?: string; shiftKey?: boolean }
          if (native.key !== 'Enter' || native.shiftKey) return
          ;(e as unknown as { preventDefault?: () => void }).preventDefault?.()
          if (value.trim()) onSubmit?.()
        }}
        placeholder="Describe an agent, app, business idea, or workflow…"
        placeholderTextColor="#71717a"
        multiline
        numberOfLines={4}
        autoFocus={Platform.OS === 'web'}
        textAlignVertical="top"
        className="min-h-[120px] rounded-xl border border-input bg-background px-4 py-3 text-base text-foreground web:outline-none"
      />
      <View className="flex-row flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <Pressable
            key={example}
            accessibilityRole="button"
            accessibilityLabel={`Use example: ${example}`}
            onPress={() => onChange(example)}
            className="rounded-full border border-border px-3 py-1.5 active:bg-muted web:hover:bg-muted"
          >
            <Text className="text-xs text-muted-foreground">{example}</Text>
          </Pressable>
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">
        Your workspace agent will research it and put a plan together before building anything.
      </Text>
    </View>
  )
}

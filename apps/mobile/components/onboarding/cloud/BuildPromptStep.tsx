// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Pressable, Text, TextInput, View } from 'react-native'

interface BuildPromptStepProps {
  value: string
  onChange: (value: string) => void
  /** Enter (without Shift) on web submits a non-empty prompt. */
  onSubmit?: () => void
  /**
   * Seconds left before a carried prompt builds itself (SHO-614), or `null`
   * when no countdown is running.
   */
  autoRunSeconds?: number | null
  /** Any interaction that means "let me look first" cancels the countdown. */
  onCancelAutoRun?: () => void
}

const EXAMPLES = [
  'A booking page for my salon',
  'A habit tracker app',
  'A landing page for my bakery',
  'An invoice generator',
]

/** Body of the team onboarding "What do you want to build?" step. */
export function BuildPromptStep({
  value,
  onChange,
  onSubmit,
  autoRunSeconds = null,
  onCancelAutoRun,
}: BuildPromptStepProps) {
  const counting = autoRunSeconds !== null
  return (
    <View className="gap-4">
      <TextInput
        testID="onboarding-build-prompt-input"
        accessibilityLabel="What do you want to build?"
        value={value}
        onChangeText={(next) => {
          // Typing is a decision to look before anything is sent.
          onCancelAutoRun?.()
          onChange(next)
        }}
        onFocus={() => {
          // Only a focus while the countdown is live is an escape: the mount
          // autofocus happens before it starts and must not cancel it.
          if (counting) onCancelAutoRun?.()
        }}
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
      {counting ? (
        <View
          testID="onboarding-auto-run"
          accessibilityLabel={`Building this in ${autoRunSeconds} seconds`}
          className="flex-row flex-wrap items-center gap-2"
        >
          <Text className="text-sm text-muted-foreground">
            Building this in {autoRunSeconds}…
          </Text>
          <Pressable
            testID="onboarding-edit-first"
            accessibilityRole="button"
            accessibilityLabel="Edit first"
            onPress={() => onCancelAutoRun?.()}
            className="rounded-md px-1 py-0.5 active:bg-muted web:hover:bg-muted"
          >
            <Text className="text-sm font-medium text-primary">Edit first</Text>
          </Pressable>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <Pressable
            key={example}
            accessibilityRole="button"
            accessibilityLabel={`Use example: ${example}`}
            onPress={() => {
              onCancelAutoRun?.()
              onChange(example)
            }}
            className="rounded-full border border-border px-3 py-1.5 active:bg-muted web:hover:bg-muted"
          >
            <Text className="text-xs text-muted-foreground">{example}</Text>
          </Pressable>
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">
        Your agent builds a first version you can open, then asks a few questions to shape the next one.
      </Text>
    </View>
  )
}

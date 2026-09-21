// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

interface AuthSurfaceProps {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}

/**
 * A calm, editorial auth canvas shared by the smaller auth flows.
 * Login owns its responsive, provider-specific surface in shared-ui.
 */
export function AuthSurface({ eyebrow, title, description, children }: AuthSurfaceProps) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 py-5 sm:px-6 sm:py-8"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View className="w-full max-w-xl self-center flex-1 justify-between">
            <View className="flex-row items-center justify-between border-b border-border pb-4">
              <View className="flex-row items-center gap-2">
                <View className="h-5 w-5 rounded-full bg-primary" />
                <Text className="text-xs font-semibold tracking-[2px] text-foreground">
                  SHOGO
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">YOUR AI AGENT</Text>
            </View>

            <View className="my-8 border border-border bg-card sm:my-12">
              <View className="border-b border-border px-5 py-4 sm:px-7">
                <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-muted-foreground">
                  {eyebrow}
                </Text>
              </View>
              <View className="px-5 py-7 sm:px-7 sm:py-9">
                <Text className="text-3xl font-semibold tracking-tight text-foreground">
                  {title}
                </Text>
                <Text className="mt-3 text-base leading-6 text-muted-foreground">
                  {description}
                </Text>
                <View className="mt-8">{children}</View>
              </View>
            </View>

            <View className="border-t border-border pt-4">
              <Text className="text-xs leading-5 text-muted-foreground">
                Shogo keeps your work, context, and agents connected.
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Slot } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function OnboardingLayout() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <Slot />
    </SafeAreaView>
  )
}

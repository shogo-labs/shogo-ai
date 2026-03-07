// SPDX-License-Identifier: AGPL-3.0-or-later
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

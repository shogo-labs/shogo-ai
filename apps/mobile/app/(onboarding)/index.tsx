// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ActivityIndicator, View } from 'react-native'
import { usePlatformConfig } from '../../lib/platform-config'
import { CloudOnboarding } from '../../components/onboarding/cloud/CloudOnboarding'

export default function OnboardingPage() {
  const { configLoaded, localMode } = usePlatformConfig()

  if (!configLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  // Local and cloud accounts share the same destination-first flow. Local
  // mode prepends its machine-specific steps (name, AI provider) and still
  // uses its local API and seeded SQLite workspaces.
  return <CloudOnboarding localMode={localMode} />
}

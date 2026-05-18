// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Redirect, Stack } from 'expo-router'
import { usePlatformConfig } from '../../../lib/platform-config'

export default function MarketplaceLayout() {
  const { features, configLoaded } = usePlatformConfig()

  // Wait for the server config before deciding (avoids a flash-redirect on cold load).
  if (configLoaded && !features.marketplace) {
    return <Redirect href="/(app)" />
  }

  return <Stack screenOptions={{ headerShown: false }} />
}

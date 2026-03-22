// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Root Layout
 *
 * Provides global app setup including:
 * - Store provider for MobX state
 * - Navigation stack setup
 */

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { StoreProvider } from '../stores'

export default function RootLayout() {
  return (
    <StoreProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#3b82f6',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      />
    </StoreProvider>
  )
}

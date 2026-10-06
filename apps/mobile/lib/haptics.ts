// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small taps under the finger for the actions that reach an agent: approving,
 * denying, answering. They do nothing on web and desktop, and never throw.
 */
import { Platform } from 'react-native'
import * as ExpoHaptics from 'expo-haptics'

function run(fn: () => Promise<unknown>): void {
  if (Platform.OS === 'web') return
  try {
    void fn().catch(() => {})
  } catch {
    // A device without a haptic engine is fine.
  }
}

export const haptics = {
  success: () => run(() => ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Success)),
  warning: () => run(() => ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Warning)),
  error: () => run(() => ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Error)),
  impact: () => run(() => ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Medium)),
  selection: () => run(() => ExpoHaptics.selectionAsync()),
}

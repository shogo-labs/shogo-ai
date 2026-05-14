// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'

declare global {
  interface Window {
    Rewardful?: { referral?: string }
  }
}

export function getRewardfulReferral(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined
  return window.Rewardful?.referral || undefined
}

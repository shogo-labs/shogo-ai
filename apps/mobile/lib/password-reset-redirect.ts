// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import * as ExpoLinking from 'expo-linking'

/**
 * `redirectTo` for Better Auth `requestPasswordReset` — where the user lands with `?token=` after the email link.
 */
export function getPasswordResetRedirectUrl(): string {
  const override = process.env.EXPO_PUBLIC_PASSWORD_RESET_REDIRECT
  if (override && override.length > 0) return override

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/reset-password`
  }

  return ExpoLinking.createURL('reset-password')
}

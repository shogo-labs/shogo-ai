// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether this build is the desktop app (or a local-mode web build).
 *
 * Its own module, with no imports beyond `react-native`: `platform-config`
 * pulls the API client, and `workspace-route` needs this check without
 * dragging that in — or creating a cycle, since `platform-config` already
 * imports from `workspace-route`.
 */
import { Platform } from 'react-native'

export function isLocalMode(): boolean {
  if (process.env.EXPO_PUBLIC_LOCAL_MODE === 'true') return true
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.isDesktop
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'

const STORAGE_KEY = 'shogo:active-workspace-id'

export function getActiveWorkspaceId(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  return window.localStorage.getItem(STORAGE_KEY)
}

export function setActiveWorkspaceId(id: string): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, id)
}

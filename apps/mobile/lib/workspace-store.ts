// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'

const STORAGE_KEY = 'shogo:active-workspace-id'

let nativeActiveWorkspaceId: string | null = null

export function getActiveWorkspaceId(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return nativeActiveWorkspaceId
  }
  return window.localStorage.getItem(STORAGE_KEY)
}

export function setActiveWorkspaceId(id: string): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    nativeActiveWorkspaceId = id
    return
  }
  window.localStorage.setItem(STORAGE_KEY, id)
}

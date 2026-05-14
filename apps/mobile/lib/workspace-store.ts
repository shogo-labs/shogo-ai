// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem } from './safe-storage'

const STORAGE_KEY = 'shogo:active-workspace-id'

let nativeActiveWorkspaceId: string | null = null

export function getActiveWorkspaceId(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return nativeActiveWorkspaceId
  }
  return safeGetItem(STORAGE_KEY)
}

export function setActiveWorkspaceId(id: string): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    nativeActiveWorkspaceId = id
    return
  }
  safeSetItem(STORAGE_KEY, id)
}

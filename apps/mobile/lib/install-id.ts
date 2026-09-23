// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import * as SecureStore from 'expo-secure-store'

const STORAGE_KEY = 'shogo_install_id_v1'
let inMemoryInstallId: string | null = null

function createInstallId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Get the stable app-install identifier stored in the native keychain. */
export async function getInstallId(): Promise<string> {
  if (inMemoryInstallId) return inMemoryInstallId

  try {
    const existing = await SecureStore.getItemAsync(STORAGE_KEY)
    if (existing) {
      inMemoryInstallId = existing
      return existing
    }
  } catch {
    // Fall through to create an in-memory id when secure storage is unavailable.
  }

  const installId = createInstallId()
  inMemoryInstallId = installId
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, installId)
  } catch {
    // The current session can still report with the generated id.
  }
  return installId
}

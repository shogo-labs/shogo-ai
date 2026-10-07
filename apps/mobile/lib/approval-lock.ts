// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An optional lock on approving an agent's action: Face ID or Touch ID on
 * iPhone, fingerprint or face unlock on Android, before Approve is sent. Off
 * by default, per device. Denying never asks. Web and desktop have no
 * biometric prompt, so they never ask either.
 */
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import * as LocalAuthentication from 'expo-local-authentication'
import { safeGetItem, safeSetItem } from './safe-storage'

const KEY = 'approval-biometric-required'

let cached = false
let hydrated = false
const listeners = new Set<(value: boolean) => void>()

async function read(): Promise<boolean> {
  try {
    const raw = Platform.OS === 'web' ? safeGetItem(KEY) : await SecureStore.getItemAsync(KEY)
    return raw === '1'
  } catch {
    return false
  }
}

async function hydrate(): Promise<boolean> {
  if (!hydrated) {
    cached = await read()
    hydrated = true
  }
  return cached
}

export async function getRequireBiometricApproval(): Promise<boolean> {
  return hydrate()
}

export async function setRequireBiometricApproval(value: boolean): Promise<void> {
  cached = value
  hydrated = true
  try {
    if (Platform.OS === 'web') safeSetItem(KEY, value ? '1' : '0')
    else await SecureStore.setItemAsync(KEY, value ? '1' : '0')
  } catch {
    // The setting still holds for this session.
  }
  listeners.forEach((l) => l(value))
}

/** Called whenever the setting changes, so the notification buttons can follow it. */
export function subscribeRequireBiometricApproval(listener: (value: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The setting as state, for the toggle in Settings. */
export function useRequireBiometricApproval(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(cached)
  useEffect(() => {
    let live = true
    void hydrate().then((v) => live && setValue(v))
    listeners.add(setValue)
    return () => {
      live = false
      listeners.delete(setValue)
    }
  }, [])
  const update = useCallback((next: boolean) => void setRequireBiometricApproval(next), [])
  return [value, update]
}

/**
 * Whether to show the biometric prompt. A phone with nothing enrolled, or no
 * hardware, skips it so the setting can never lock someone out.
 */
export function shouldPromptBiometric(input: { platform: string; enabled: boolean; hasHardware: boolean; enrolled: boolean }): boolean {
  if (input.platform === 'web') return false
  return input.enabled && input.hasHardware && input.enrolled
}

/** True when the approval may go ahead. */
export async function confirmApproval(reason: string): Promise<boolean> {
  const enabled = await getRequireBiometricApproval()
  if (!enabled || Platform.OS === 'web') return true
  try {
    const [hasHardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()])
    if (!shouldPromptBiometric({ platform: Platform.OS, enabled, hasHardware, enrolled })) return true
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel' })
    return result.success
  } catch {
    return false
  }
}

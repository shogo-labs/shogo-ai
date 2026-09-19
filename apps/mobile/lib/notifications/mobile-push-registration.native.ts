// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { useEffect } from 'react'
import { api, createHttpClient } from '../api'
import { ensureNotificationPermission } from './chat-notifier'
import { getNotifyOnTurnComplete } from './preferences'

let registeredDevice: { userId: string; pushToken: string } | null = null
let registrationInFlight: Promise<void> | null = null

async function unregisterRegisteredDevice(): Promise<void> {
  const device = registeredDevice
  if (!device) return

  // Clear the local marker before awaiting the network request so a logout or
  // account switch cannot continue suppressing local notifications if the
  // server is temporarily unavailable.
  registeredDevice = null
  try {
    await api.unregisterMobilePushSubscription(createHttpClient(), device.pushToken)
  } catch {
    // The subscription is best-effort. A later login registers the current
    // account again, and the server removes invalid tokens when delivering.
  }
}

async function registerCurrentDevice(userId: string, enabled: boolean) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return

  if (registeredDevice?.userId !== userId) {
    await unregisterRegisteredDevice()
  }

  if (!enabled) {
    await unregisterRegisteredDevice()
    return
  }

  if (!(await ensureNotificationPermission())) return

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  const tokenResponse = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  )
  const pushToken = tokenResponse.data
  if (!pushToken || (registeredDevice?.userId === userId && registeredDevice.pushToken === pushToken)) return

  const http = createHttpClient()
  await api.registerMobilePushSubscription(http, {
    pushToken,
    platform: Platform.OS,
  })
  registeredDevice = { userId, pushToken }
}

export function hasRegisteredMobilePushSubscription(): boolean {
  return registeredDevice !== null && getNotifyOnTurnComplete()
}

export function useMobilePushRegistration(userId: string | null, enabled = true) {
  useEffect(() => {
    let cancelled = false

    const register = async () => {
      if (registrationInFlight) await registrationInFlight.catch(() => {})
      if (cancelled) return

      const request = userId
        ? registerCurrentDevice(userId, enabled)
        : unregisterRegisteredDevice()
      registrationInFlight = request.finally(() => {
        registrationInFlight = null
      })
      await registrationInFlight.catch(() => {})
    }
    void register()

    return () => { cancelled = true }
  }, [enabled, userId])
}

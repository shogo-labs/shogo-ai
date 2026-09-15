// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { useEffect } from 'react'
import { api, createHttpClient } from '../api'
import { ensureNotificationPermission } from './chat-notifier'

let registeredDevice: { userId: string; pushToken: string } | null = null
let registrationInFlight: Promise<void> | null = null

async function registerCurrentDevice(userId: string) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return
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

export function useMobilePushRegistration(userId: string | null) {
  useEffect(() => {
    let cancelled = false
    if (!userId) return () => { cancelled = true }

    const register = async () => {
      if (registrationInFlight) await registrationInFlight.catch(() => {})
      if (cancelled) return

      const request = registerCurrentDevice(userId)
      registrationInFlight = request.finally(() => {
        registrationInFlight = null
      })
      await registrationInFlight.catch(() => {})
    }
    void register()

    return () => { cancelled = true }
  }, [userId])
}

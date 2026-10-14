// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { useEffect } from 'react'
import { api, createHttpClient } from '../api'
import * as Sentry from '@sentry/react-native'
import {
  ensureNotificationPermission,
  getNotificationPermissionState,
  subscribeNotificationPermissionGranted,
} from './chat-notifier'
import { getNotifyOnTurnComplete } from './preferences'

let registeredDevice: { userId: string; pushToken: string; agentTurns: boolean } | null = null
const pushTokenListeners = new Set<(token: string | null) => void>()

/** Told the device's push token when it registers, and null when it is unregistered. */
export function subscribePushToken(listener: (token: string | null) => void): () => void {
  pushTokenListeners.add(listener)
  listener(registeredDevice?.pushToken ?? null)
  return () => pushTokenListeners.delete(listener)
}

function notifyPushToken(token: string | null) {
  pushTokenListeners.forEach((l) => l(token))
}
let registrationInFlight: Promise<void> | null = null

function reportRegistrationProblem(message: string) {
  console.warn(`[push] ${message}`)
  Sentry.addBreadcrumb({ category: 'push', level: 'warning', message })
}

async function unregisterRegisteredDevice(): Promise<void> {
  const device = registeredDevice
  if (!device) return

  // Clear the local marker before awaiting the network request so a logout or
  // account switch cannot continue suppressing local notifications if the
  // server is temporarily unavailable.
  registeredDevice = null
  notifyPushToken(null)
  try {
    await api.unregisterMobilePushSubscription(createHttpClient(), device.pushToken)
  } catch {
    // The subscription is best-effort. A later login registers the current
    // account again, and the server removes invalid tokens when delivering.
  }
}

/**
 * Register this device for pushes while signed in. `agentTurns` only
 * controls agent turn/task completion pushes; team chat pushes always
 * arrive and are governed by chat preferences on the server.
 */
async function registerCurrentDevice(userId: string, agentTurns: boolean) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return

  if (registeredDevice?.userId !== userId) {
    await unregisterRegisteredDevice()
  }

  if (!(await ensureNotificationPermission())) {
    reportRegistrationProblem('Notification permission not granted; this device will not get pushes')
    return
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  let pushToken: string | undefined
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    )
    pushToken = tokenResponse.data
  } catch (err) {
    reportRegistrationProblem(`Could not get an Expo push token: ${(err as Error).message}`)
    return
  }
  if (!pushToken) {
    reportRegistrationProblem('Expo returned an empty push token')
    return
  }
  if (registeredDevice?.userId === userId && registeredDevice.pushToken === pushToken && registeredDevice.agentTurns === agentTurns) return

  const http = createHttpClient()
  try {
    await api.registerMobilePushSubscription(http, {
      pushToken,
      platform: Platform.OS,
      agentTurns,
    })
  } catch (err) {
    reportRegistrationProblem(`Could not register this device for pushes: ${(err as Error).message}`)
    return
  }
  registeredDevice = { userId, pushToken, agentTurns }
  notifyPushToken(pushToken)
}

/** True when the server will push agent turn completions to this device. */
export function hasRegisteredMobilePushSubscription(): boolean {
  return registeredDevice !== null && registeredDevice.agentTurns && getNotifyOnTurnComplete()
}

export function useMobilePushRegistration(userId: string | null, agentTurns = true) {
  useEffect(() => {
    let cancelled = false

    const register = async () => {
      if (registrationInFlight) await registrationInFlight.catch(() => {})
      if (cancelled) return

      const request = userId
        ? registerCurrentDevice(userId, agentTurns)
        : unregisterRegisteredDevice()
      registrationInFlight = request.finally(() => {
        registrationInFlight = null
      })
      await registrationInFlight.catch((err) => {
        reportRegistrationProblem(`Push registration failed: ${(err as Error).message}`)
      })
    }
    void register()
    // Permission granted later (from the settings button, or in iOS Settings)
    // registers the device then instead of waiting for the next sign-in.
    const unsubscribe = userId ? subscribeNotificationPermissionGranted(() => void register()) : () => {}
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !userId || registeredDevice) return
      void getNotificationPermissionState().then((s) => {
        if (s === 'granted') void register()
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
      appState.remove()
    }
  }, [agentTurns, userId])
}

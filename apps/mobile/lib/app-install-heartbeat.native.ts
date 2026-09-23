// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { AppState, Platform, type AppStateStatus } from 'react-native'
import * as Device from 'expo-device'
import { useEffect } from 'react'
import { api, createHttpClient } from './api'
import { getAppVersion } from './app-version'
import { getInstallId } from './install-id'

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000
const lastHeartbeatByUser = new Map<string, number>()
const heartbeatInFlightByUser = new Map<string, Promise<void>>()

async function sendHeartbeat(userId: string): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return

  const lastHeartbeat = lastHeartbeatByUser.get(userId) ?? 0
  if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return
  const existingRequest = heartbeatInFlightByUser.get(userId)
  if (existingRequest) return existingRequest

  const request = (async () => {
    const deviceId = await getInstallId()
    await api.sendAppInstallHeartbeat(createHttpClient(), {
      deviceId,
      platform: Platform.OS,
      appVersion: getAppVersion(),
      osVersion: Device.osVersion,
      deviceModel: Device.modelName,
    })
    lastHeartbeatByUser.set(userId, Date.now())
  })().catch(() => {
    // Install tracking is best-effort and must never affect app startup.
  }).finally(() => {
    heartbeatInFlightByUser.delete(userId)
  })

  heartbeatInFlightByUser.set(userId, request)
  await request
}

export function useAppInstallHeartbeat(userId: string | null) {
  useEffect(() => {
    if (!userId) return

    let cancelled = false
    const sendIfCurrent = () => {
      if (!cancelled) void sendHeartbeat(userId)
    }
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') sendIfCurrent()
    })

    sendIfCurrent()
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [userId])
}

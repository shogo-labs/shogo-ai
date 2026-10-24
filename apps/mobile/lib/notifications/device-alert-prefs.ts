// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Alert settings that belong to this device rather than the account: whether
 * the dock icon bounces and whether the taskbar button flashes. They live in
 * local storage, so each machine can differ (as in Slack).
 */

export type DockBounce = 'off' | 'once' | 'until-focused'

export interface DeviceAlertPrefs {
  dockBounce: DockBounce
  flashTaskbar: boolean
}

export const DEFAULT_DEVICE_ALERT_PREFS: DeviceAlertPrefs = {
  dockBounce: 'once',
  flashTaskbar: true,
}

const STORAGE_KEY = 'shogo.deviceAlertPrefs'

const listeners = new Set<(prefs: DeviceAlertPrefs) => void>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function isDockBounce(value: unknown): value is DockBounce {
  return value === 'off' || value === 'once' || value === 'until-focused'
}

export function readDeviceAlertPrefs(): DeviceAlertPrefs {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) return { ...DEFAULT_DEVICE_ALERT_PREFS }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceAlertPrefs>
    return {
      dockBounce: isDockBounce(parsed.dockBounce) ? parsed.dockBounce : DEFAULT_DEVICE_ALERT_PREFS.dockBounce,
      flashTaskbar: typeof parsed.flashTaskbar === 'boolean' ? parsed.flashTaskbar : DEFAULT_DEVICE_ALERT_PREFS.flashTaskbar,
    }
  } catch {
    return { ...DEFAULT_DEVICE_ALERT_PREFS }
  }
}

export function writeDeviceAlertPrefs(patch: Partial<DeviceAlertPrefs>): DeviceAlertPrefs {
  const next = { ...readDeviceAlertPrefs(), ...patch }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be full or disabled; the setting then lasts for this session only.
  }
  for (const l of listeners) l(next)
  return next
}

export function subscribeDeviceAlertPrefs(listener: (prefs: DeviceAlertPrefs) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

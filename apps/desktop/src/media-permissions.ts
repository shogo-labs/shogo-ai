// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * macOS microphone and camera (TCC) access.
 *
 * Chromium-level permission (`setPermissionRequestHandler`) is separate from
 * the OS-level grant. On macOS the app has to ask the OS itself; otherwise
 * `getUserMedia` fails or yields silence with no prompt ever shown.
 */

export type MicAccess = 'granted' | 'denied' | 'restricted'
export type MediaDevice = 'microphone' | 'camera'

export interface MicAccessDeps {
  platform: NodeJS.Platform
  getMediaAccessStatus: (mediaType: MediaDevice) => string
  askForMediaAccess: (mediaType: MediaDevice) => Promise<boolean>
}

export const MAC_MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/** Resolve the OS grant for a capture device, prompting once if undetermined (macOS only). */
export async function ensureMediaAccess(deps: MicAccessDeps, device: MediaDevice): Promise<MicAccess> {
  if (deps.platform !== 'darwin') return 'granted'

  let status: string
  try {
    status = deps.getMediaAccessStatus(device)
  } catch {
    return 'denied'
  }

  if (status === 'granted') return 'granted'
  if (status === 'restricted') return 'restricted'
  if (status === 'denied') return 'denied'

  // 'not-determined' (or unknown): trigger the system prompt.
  try {
    return (await deps.askForMediaAccess(device)) ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** Resolve the OS microphone grant, prompting once if undetermined (macOS only). */
export function ensureMicAccess(deps: MicAccessDeps): Promise<MicAccess> {
  return ensureMediaAccess(deps, 'microphone')
}

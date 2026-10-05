// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * macOS microphone (TCC) access.
 *
 * Chromium-level permission (`setPermissionRequestHandler`) is separate from
 * the OS-level grant. On macOS the app has to ask the OS itself; otherwise
 * `getUserMedia` fails or yields silence with no prompt ever shown.
 */

export type MicAccess = 'granted' | 'denied' | 'restricted'

export interface MicAccessDeps {
  platform: NodeJS.Platform
  getMediaAccessStatus: (mediaType: 'microphone') => string
  askForMediaAccess: (mediaType: 'microphone') => Promise<boolean>
}

export const MAC_MIC_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/** Resolve the OS microphone grant, prompting once if undetermined (macOS only). */
export async function ensureMicAccess(deps: MicAccessDeps): Promise<MicAccess> {
  if (deps.platform !== 'darwin') return 'granted'

  let status: string
  try {
    status = deps.getMediaAccessStatus('microphone')
  } catch {
    return 'denied'
  }

  if (status === 'granted') return 'granted'
  if (status === 'restricted') return 'restricted'
  if (status === 'denied') return 'denied'

  // 'not-determined' (or unknown): trigger the system prompt.
  try {
    return (await deps.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

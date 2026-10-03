// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * macOS privacy (TCC) permissions used by "computer use", "files and local
 * apps" and dictation: Accessibility, Screen Recording, Full Disk Access and
 * the microphone.
 *
 * The core is dependency-injected (like `media-permissions.ts`) so it can be
 * unit tested without Electron. `main.ts` supplies the real deps.
 */

export type PermissionKind = 'accessibility' | 'screen' | 'fullDisk' | 'mic'

/**
 * - `granted`: usable now.
 * - `denied`: the user (or MDM) refused, or the grant is not effective yet.
 * - `not-determined`: never asked.
 * - `unsupported`: not applicable on this platform (non-macOS).
 */
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'

export type PermissionStatus = Record<PermissionKind, PermissionState>

export const PERMISSION_KINDS: readonly PermissionKind[] = ['accessibility', 'screen', 'fullDisk', 'mic']

export const MAC_SETTINGS_URLS: Record<PermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
}

export function isPermissionKind(value: unknown): value is PermissionKind {
  return typeof value === 'string' && (PERMISSION_KINDS as readonly string[]).includes(value)
}

export interface OsPermissionDeps {
  platform: NodeJS.Platform
  homeDir: string
  isTrustedAccessibilityClient: (prompt: boolean) => boolean
  getMediaAccessStatus: (mediaType: 'microphone' | 'screen') => string
  askForMicrophoneAccess: () => Promise<boolean>
  /** Triggers the macOS Screen Recording prompt (e.g. a throwaway capture). */
  triggerScreenCapturePrompt: () => Promise<void>
  /** Reads a path; must throw with `code` when access is refused. */
  probeRead: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
}

/**
 * Paths that only a process with Full Disk Access can list. The first one that
 * exists decides: `EPERM`/`EACCES` means not granted; success means granted.
 * `ENOENT` is inconclusive, so we move to the next candidate.
 */
export function fullDiskProbePaths(homeDir: string): string[] {
  return [
    `${homeDir}/Library/Safari`,
    `${homeDir}/Library/Messages`,
    `${homeDir}/Library/Mail`,
    '/Library/Application Support/com.apple.TCC',
  ]
}

export async function getFullDiskState(deps: OsPermissionDeps): Promise<PermissionState> {
  if (deps.platform !== 'darwin') return 'unsupported'
  for (const p of fullDiskProbePaths(deps.homeDir)) {
    try {
      await deps.probeRead(p)
      return 'granted'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EPERM' || code === 'EACCES') return 'denied'
      // ENOENT / anything else: inconclusive, try the next path.
    }
  }
  return 'not-determined'
}

function mapMediaStatus(status: string): PermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'not-determined':
      return 'not-determined'
    case 'denied':
    case 'restricted':
      return 'denied'
    default:
      return 'not-determined'
  }
}

export async function getPermissionStatus(deps: OsPermissionDeps): Promise<PermissionStatus> {
  if (deps.platform !== 'darwin') {
    return { accessibility: 'unsupported', screen: 'unsupported', fullDisk: 'unsupported', mic: 'granted' }
  }

  let accessibility: PermissionState = 'denied'
  try {
    accessibility = deps.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  } catch {
    accessibility = 'denied'
  }

  let screen: PermissionState = 'denied'
  try {
    screen = mapMediaStatus(deps.getMediaAccessStatus('screen'))
  } catch {
    screen = 'denied'
  }

  let mic: PermissionState = 'denied'
  try {
    mic = mapMediaStatus(deps.getMediaAccessStatus('microphone'))
  } catch {
    mic = 'denied'
  }

  return { accessibility, screen, fullDisk: await getFullDiskState(deps), mic }
}

export interface RequestResult {
  /** State after the request. May lag the OS (Screen Recording needs a relaunch). */
  state: PermissionState
  /** True when we sent the user to System Settings instead of a native prompt. */
  openedSettings: boolean
}

/**
 * Ask for a permission. Where macOS offers a native prompt we use it once; if
 * the permission was already refused (macOS never re-prompts) or has no prompt
 * API (Full Disk Access), we open the matching System Settings pane.
 */
export async function requestPermission(
  deps: OsPermissionDeps,
  kind: PermissionKind,
): Promise<RequestResult> {
  if (deps.platform !== 'darwin') {
    return { state: kind === 'mic' ? 'granted' : 'unsupported', openedSettings: false }
  }

  const current = (await getPermissionStatus(deps))[kind]
  if (current === 'granted') return { state: 'granted', openedSettings: false }

  const openSettings = async (): Promise<RequestResult> => {
    try {
      await deps.openExternal(MAC_SETTINGS_URLS[kind])
    } catch {
      /* best effort */
    }
    return { state: current, openedSettings: true }
  }

  switch (kind) {
    case 'accessibility': {
      // The prompt shows the first time; afterwards macOS only lists the app in
      // Settings, so send the user there as well.
      let trusted = false
      try {
        trusted = deps.isTrustedAccessibilityClient(true)
      } catch {
        trusted = false
      }
      if (trusted) return { state: 'granted', openedSettings: false }
      return openSettings()
    }
    case 'screen': {
      if (current === 'not-determined') {
        try {
          await deps.triggerScreenCapturePrompt()
        } catch {
          /* the prompt side effect is what matters */
        }
        const after = mapMediaStatus(safeMedia(deps, 'screen'))
        if (after === 'granted') return { state: 'granted', openedSettings: false }
      }
      return openSettings()
    }
    case 'mic': {
      if (current === 'not-determined') {
        let ok = false
        try {
          ok = await deps.askForMicrophoneAccess()
        } catch {
          ok = false
        }
        if (ok) return { state: 'granted', openedSettings: false }
        return { state: 'denied', openedSettings: false }
      }
      return openSettings()
    }
    case 'fullDisk':
      return openSettings()
  }
}

function safeMedia(deps: OsPermissionDeps, type: 'microphone' | 'screen'): string {
  try {
    return deps.getMediaAccessStatus(type)
  } catch {
    return 'denied'
  }
}

export async function openPermissionSettings(deps: OsPermissionDeps, kind: PermissionKind): Promise<boolean> {
  if (deps.platform !== 'darwin') return false
  try {
    await deps.openExternal(MAC_SETTINGS_URLS[kind])
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Local apps
// ---------------------------------------------------------------------------

export interface LocalAppDef {
  id: 'mail' | 'messages' | 'notes' | 'whatsapp'
  name: string
  /** Bundle names to look for in /Applications, ~/Applications, /System/Applications. */
  bundles: string[]
}

export const LOCAL_APPS: readonly LocalAppDef[] = [
  { id: 'mail', name: 'Mail.app', bundles: ['Mail.app'] },
  { id: 'messages', name: 'Messages.app', bundles: ['Messages.app'] },
  { id: 'notes', name: 'Notes.app', bundles: ['Notes.app'] },
  { id: 'whatsapp', name: 'WhatsApp.app', bundles: ['WhatsApp.app', 'WhatsApp.localized/WhatsApp.app'] },
]

export interface LocalAppInfo {
  id: LocalAppDef['id']
  name: string
  installed: boolean
}

export async function listLocalApps(deps: {
  platform: NodeJS.Platform
  homeDir: string
  exists: (path: string) => Promise<boolean>
}): Promise<LocalAppInfo[]> {
  const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', `${deps.homeDir}/Applications`]
  const out: LocalAppInfo[] = []
  for (const app of LOCAL_APPS) {
    let installed = false
    if (deps.platform === 'darwin') {
      outer: for (const root of roots) {
        for (const bundle of app.bundles) {
          if (await deps.exists(`${root}/${bundle}`)) {
            installed = true
            break outer
          }
        }
      }
    }
    out.push({ id: app.id, name: app.name, installed })
  }
  return out
}

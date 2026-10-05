// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed access to the Electron preload bridge (`window.shogoDesktop`).
 *
 * Only the surface used by onboarding, settings and dictation is typed here;
 * everything is optional because older desktop builds expose less.
 */

export type MicAccessResult = 'granted' | 'denied' | 'restricted'

export type PermissionKind = 'accessibility' | 'screen' | 'fullDisk' | 'mic'
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'
export type PermissionStatus = Record<PermissionKind, PermissionState>

export const EMPTY_PERMISSION_STATUS: PermissionStatus = {
  accessibility: 'unsupported',
  screen: 'unsupported',
  fullDisk: 'unsupported',
  mic: 'unsupported',
}

export interface PermissionRequestResult {
  ok: boolean
  error?: string
  state?: PermissionState
  openedSettings?: boolean
  status?: PermissionStatus
}

export type LocalAppId = 'mail' | 'messages' | 'notes' | 'whatsapp'

export interface LocalAppInfo {
  id: LocalAppId
  name: string
  installed: boolean
}

export interface DictationShortcutConfig {
  /** `Fn`, or an Electron accelerator-style combo such as `Control+Option+Space`. */
  pushToTalk: string | null
  /** Electron accelerator that toggles dictation on/off. */
  handsFree: string | null
}

export interface DictationHotkeyState {
  /** Whether the native Fn listener is running (needs Accessibility). */
  fnAvailable: boolean
}

export interface DesktopBridge {
  isDesktop?: boolean
  platform?: string
  ensureMicAccess?: () => Promise<MicAccessResult>
  openMicrophoneSettings?: () => Promise<{ ok: boolean }>
  pickFolders?: (opts?: { multi?: boolean; defaultPath?: string }) => Promise<
    { ok: true; paths: string[] } | { ok: false; error?: string }
  >
  permissions?: {
    getStatus: () => Promise<PermissionStatus>
    request: (kind: PermissionKind) => Promise<PermissionRequestResult>
    openSettings: (kind: PermissionKind) => Promise<{ ok: boolean }>
    listLocalApps: () => Promise<LocalAppInfo[]>
    relaunch: () => Promise<void>
  }
  dictation?: {
    getConfig: () => Promise<DictationShortcutConfig>
    setConfig: (patch: Partial<DictationShortcutConfig>) => Promise<{
      ok: boolean
      error?: string
      config: DictationShortcutConfig
    }>
    getHotkeyState: () => Promise<DictationHotkeyState>
    /** Subscribe to global push-to-talk / hands-free events. Returns an unsubscribe fn. */
    onEvent: (cb: (event: { type: 'start' | 'stop' | 'cancel'; mode: 'push' | 'toggle' }) => void) => () => void
    /** Hand the transcript back to main so it can paste it into the focused app. */
    deliverText: (text: string) => Promise<{ ok: boolean; pasted: boolean }>
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  const d = (window as { shogoDesktop?: DesktopBridge }).shogoDesktop
  return d?.isDesktop ? d : null
}

/** True on the macOS desktop shell, where the onboarding permission steps apply. */
export function isMacDesktop(): boolean {
  const d = getDesktopBridge()
  return !!d && d.platform === 'darwin' && !!d.permissions
}

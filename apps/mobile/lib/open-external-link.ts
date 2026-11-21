// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one way this app hands a URL to something outside itself.
 *
 * `Linking.openURL` returns a promise that rejects, and on Android it rejects
 * for two everyday cases: a `data:` URL (`Could not open URL 'data:…'`, no app
 * can view one) and a `tel:` on a device with no dialer (`ActivityNotFound
 * Exception`). An unhandled rejection there is a native crash report, so every
 * open goes through here: the failure is caught, the person is told once, and
 * nothing is ever thrown into a press handler (SHO-436).
 *
 * An http(s) link opens in the in-app browser (`expo-web-browser` presents
 * `SFSafariViewController` / Custom Tabs), which is also what keeps the login
 * screen's Terms and Privacy links readable inside the app (SHO-430). Every
 * other scheme — `tel:`, `mailto:`, `sms:` — belongs to the OS, so it goes
 * straight to the system opener instead of a browser that cannot show it.
 */
import * as WebBrowser from 'expo-web-browser'
import { Alert, Linking, Platform } from 'react-native'

/** Schemes nothing can launch, and no page should ever navigate to. */
const UNOPENABLE_SCHEME = /^(?:data|javascript|vbscript|blob|about):/i
const WEB_SCHEME = /^https?:/i

/**
 * True when an opener outside the app can take this URL. A `data:` URL is
 * content, not an address: Android throws on it, and the bytes it carries
 * belong in the app's own viewer (see `decodeDataUrlText`).
 */
export function isOpenableUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false
  return !UNOPENABLE_SCHEME.test(trimmed)
}

/** What went wrong, in words a person can act on. */
function failureMessage(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase()
  if (scheme === 'tel') return 'This device has no app that can make a call.'
  if (scheme === 'mailto') return 'This device has no email app set up.'
  return 'This link cannot be opened on this device.'
}

export interface OpenExternalLinkOptions {
  /**
   * Report nothing on failure. For a link inside a consent notice, where an
   * alert would interrupt what the person is doing (the login screen, SHO-430).
   */
  silent?: boolean
}

function reportFailure(url: string, options: OpenExternalLinkOptions): void {
  if (options.silent) return
  const message = failureMessage(url)
  if (Platform.OS === 'web') {
    console.warn('[openExternalLink]', message, url)
    return
  }
  Alert.alert("Couldn't open link", message)
}

async function openWithSystem(url: string, options: OpenExternalLinkOptions): Promise<boolean> {
  try {
    await Linking.openURL(url)
    return true
  } catch (error) {
    // The system opener owns this URL and refused it: nothing to hand over.
    console.warn('[openExternalLink] the system could not open the link', url.slice(0, 96), error)
    reportFailure(url, options)
    return false
  }
}

/**
 * Open a link outside the app. Never throws; a failure is reported to the
 * person (unless `silent`) and resolves.
 */
export async function openExternalLink(
  url: string,
  options: OpenExternalLinkOptions = {},
): Promise<void> {
  if (!isOpenableUrl(url)) {
    console.warn('[openExternalLink] refusing a URL no opener can launch', url.slice(0, 96))
    reportFailure(url, options)
    return
  }

  if (!WEB_SCHEME.test(url.trim())) {
    await openWithSystem(url, options)
    return
  }

  try {
    await WebBrowser.openBrowserAsync(url)
    return
  } catch (error) {
    console.warn('[openExternalLink] in-app browser failed', url, error)
  }
  await openWithSystem(url, options)
}

/**
 * Hand a download URL (a CSV export, a report) to whatever can fetch it: a new
 * tab on web, the in-app browser on native. React Native defines `window` but
 * not `window.open`, so a `typeof window` check sent native taps into
 * "undefined is not a function" (Sentry SHOGO-ANDROID-23 / -T, Members →
 * Export usage CSV).
 */
export function openDownloadUrl(url: string): void {
  const open = typeof window !== 'undefined' ? (window as { open?: unknown }).open : undefined
  if (Platform.OS === 'web' && typeof open === 'function') {
    ;(open as (url: string, target: string, features: string) => unknown).call(window, url, '_blank', 'noopener')
    return
  }
  void openExternalLink(url)
}

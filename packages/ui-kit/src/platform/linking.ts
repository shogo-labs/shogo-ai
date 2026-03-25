// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Linking as RNLinking } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'

export const linking = {
  openURL(url: string) {
    if (Platform.OS === 'web') {
      window.open(url, '_blank', 'noopener,noreferrer')
    } else {
      RNLinking.openURL(url)
    }
  },

  canOpenURL(url: string): Promise<boolean> {
    if (Platform.OS === 'web') {
      return Promise.resolve(true)
    }
    return RNLinking.canOpenURL(url)
  },
}

/**
 * Detect mobile web browsers where popup windows are unreliable.
 * Mobile browsers either block popups entirely or open them as new tabs
 * with broken `window.closed` detection.
 */
export function isMobileWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  )
}

/**
 * Pre-create a popup window synchronously during a user gesture so it is not
 * blocked by mobile popup blockers. Call this BEFORE any async work (API calls)
 * and pass the result to `openAuthFlow` via `options.preCreatedWindow`.
 *
 * Returns `null` on non-web platforms or if the browser blocks it.
 */
export function preCreateAuthWindow(
  options?: { width?: number; height?: number },
): Window | null {
  if (Platform.OS !== 'web') return null

  if (isMobileWeb()) {
    // Mobile: open about:blank in a new tab (no popup features that get blocked)
    return window.open('about:blank', 'auth-flow') ?? null
  }

  const w = options?.width ?? 600
  const h = options?.height ?? 700
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2)
  return (
    window.open(
      'about:blank',
      'auth-flow',
      `width=${w},height=${h},left=${left},top=${top},popup=true`,
    ) ?? null
  )
}

export interface OpenAuthFlowOptions {
  popup?: { width?: number; height?: number }
  /**
   * A pre-created popup/tab from `preCreateAuthWindow()`. Pass this when the
   * auth URL is obtained asynchronously (e.g. after an API call) to avoid
   * mobile popup blockers that reject `window.open` outside a user gesture.
   */
  preCreatedWindow?: Window | null
}

/**
 * Open an external auth/OAuth flow and wait for the user to return.
 *
 * - Web (desktop): opens a centered popup and resolves when it closes.
 * - Web (mobile): navigates a pre-created tab to the auth URL and resolves
 *   immediately (callers must poll the API for connection status).
 * - Native: opens a Chrome Custom Tab / SFSafariViewController via
 *   `openAuthSessionAsync` and auto-closes when the browser navigates
 *   to the app's `shogo://` deep-link scheme.
 */
export async function openAuthFlow(
  url: string,
  options?: OpenAuthFlowOptions,
): Promise<{ type: 'success' | 'cancel' | 'dismiss'; url?: string }> {
  if (Platform.OS === 'web') {
    const mobile = isMobileWeb()
    let popup: Window | null = options?.preCreatedWindow ?? null

    if (popup) {
      try {
        popup.location.href = url
      } catch {
        // COOP may prevent cross-origin location assignment; open fresh
        popup = window.open(url, 'auth-flow') ?? null
      }
    } else if (mobile) {
      // Mobile fallback: try opening a new tab (may still be blocked)
      popup = window.open(url, '_blank') ?? null
      if (!popup) {
        console.warn('[OAuth] Popup blocked on mobile — falling back to redirect')
        try {
          sessionStorage.setItem(
            'shogo_oauth_return',
            window.location.href,
          )
        } catch { /* sessionStorage unavailable */ }
        window.location.href = url
        return new Promise(() => {})
      }
    } else {
      // Desktop: centered popup (original behavior)
      const w = options?.popup?.width ?? 600
      const h = options?.popup?.height ?? 700
      const left = Math.round(window.screenX + (window.outerWidth - w) / 2)
      const top = Math.round(window.screenY + (window.outerHeight - h) / 2)
      popup = window.open(
        url,
        'auth-flow',
        `width=${w},height=${h},left=${left},top=${top},popup=true`,
      )
    }

    if (!popup) {
      console.warn('[OAuth] Browser blocked the auth popup/tab')
      return { type: 'cancel' }
    }

    if (mobile) {
      // On mobile we cannot reliably detect tab closure. Resolve after a
      // short delay so callers proceed to polling immediately.
      await new Promise((r) => setTimeout(r, 500))
      return { type: 'success' }
    }

    // Desktop: monitor popup until closed
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        try {
          if (popup?.closed) {
            clearInterval(interval)
            resolve({ type: 'success' })
          }
        } catch {
          // COOP headers sever the reference — treat as success and let polling detect state
          clearInterval(interval)
          resolve({ type: 'success' })
        }
      }, 500)
      setTimeout(() => {
        clearInterval(interval)
        resolve({ type: 'cancel' })
      }, 120_000)
    })
  }

  const scheme = ExpoLinking.createURL('')
  return WebBrowser.openAuthSessionAsync(url, scheme)
}

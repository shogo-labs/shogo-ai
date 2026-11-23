// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Sign in with Shogo" for learn.shogo.ai.
 *
 * learn.shogo.ai sends a signed-out visitor to `/api/learn/sso`, which sends
 * them to `/sign-in?learn_return=<learn url>`. The return URL is kept in
 * sessionStorage so it survives the Google/Apple redirect, and once the user is
 * signed in the app hands them back to `/api/learn/sso`, which sets the learn
 * cookie and redirects to the learn page. The API re-validates the URL against
 * its own allow-list; the check here only keeps the app from bouncing to junk.
 */
import { Platform } from 'react-native'

const STORAGE_KEY = 'shogo:learn-return'
const PARAM = 'learn_return'

export function isLearnReturnUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') {
      return url.hostname === 'learn.shogo.ai' || url.hostname === 'learn.staging.shogo.ai'
    }
    return url.protocol === 'http:' && url.hostname === 'localhost'
  } catch {
    return false
  }
}

function storage(): Storage | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Store `?learn_return=` from the current URL, if present and valid. */
export function captureLearnReturn(): void {
  const store = storage()
  if (!store) return
  const raw = new URLSearchParams(window.location.search).get(PARAM)
  if (isLearnReturnUrl(raw)) store.setItem(STORAGE_KEY, raw as string)
}

export function peekLearnReturn(): string | null {
  const value = storage()?.getItem(STORAGE_KEY) ?? null
  return isLearnReturnUrl(value) ? value : null
}

/**
 * If a learn return is pending, clear it and send the browser to the SSO hop.
 * Returns true when it navigated, so the caller can render a spinner.
 */
export function resumeLearnReturn(apiUrl: string): boolean {
  const target = peekLearnReturn()
  if (!target) return false
  storage()?.removeItem(STORAGE_KEY)
  window.location.replace(`${apiUrl}/api/learn/sso?return=${encodeURIComponent(target)}`)
  return true
}

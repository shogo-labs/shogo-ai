// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Opening a Stripe Checkout session and coming back from it.
 *
 * Checkout is a hosted page, so every purchase flow in the app ends the same
 * way: hand the buyer to `session.url`, wait for the app's own scheme to reopen,
 * then verify the session because the webhook may not have landed yet. This was
 * inline in the Billing screen's plan checkout; the Solo Founder offer needs the
 * exact same dance, so it lives here instead of being copied.
 */
import { Platform } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import type { HttpClient } from '@shogo-ai/sdk'
import { api } from './api'

/**
 * The URL Checkout sends the buyer back to: the app's own deep link on a
 * device, the current origin on web. `undefined` when neither is available,
 * in which case the server's default is used.
 */
export function checkoutRedirectBase(): string | undefined {
  if (Platform.OS !== 'web') return ExpoLinking.createURL('billing')
  return typeof window !== 'undefined' ? window.location.origin : undefined
}

export interface NativeCheckoutResult {
  /** `success` or `cancel` from the redirect URL's `checkout` param. */
  checkout: string | null
  sessionId: string | null
  /** `/api/billing/verify-checkout` payload, when we had a session to verify. */
  verifiedCheckout: Awaited<ReturnType<typeof api.verifyCheckout>> | null
}

/**
 * Open a Checkout URL in the browser sheet and verify the session when the app
 * reopens. Never throws for a cancel: `checkout` is null and the caller carries
 * on. A failed verify is logged and swallowed — the webhook is the source of
 * truth, and the caller refetches anyway.
 */
export async function completeNativeCheckout(
  http: HttpClient,
  url: string,
): Promise<NativeCheckoutResult> {
  const empty: NativeCheckoutResult = { checkout: null, sessionId: null, verifiedCheckout: null }
  const scheme = ExpoLinking.createURL('')
  console.log('[Checkout] opening auth session, scheme prefix:', scheme)
  const result = await WebBrowser.openAuthSessionAsync(url, scheme)
  console.log('[Checkout] auth session result:', {
    type: result.type,
    url: 'url' in result ? result.url : undefined,
  })
  if (result.type !== 'success' || !('url' in result) || !result.url) return empty

  const qs = result.url.split('?')[1] || ''
  const params = new URLSearchParams(qs)
  const checkout = params.get('checkout')
  const sessionId = params.get('session_id')
  console.log('[Checkout] parsed redirect params:', { checkout, sessionId })
  if (!sessionId) return { checkout, sessionId: null, verifiedCheckout: null }

  let verifiedCheckout: NativeCheckoutResult['verifiedCheckout'] = null
  try {
    verifiedCheckout = await api.verifyCheckout(http, sessionId)
    console.log('[Checkout] verify result:', verifiedCheckout)
  } catch (verifyErr) {
    console.warn('[Checkout] verify failed (webhook will handle):', verifyErr)
  }
  return { checkout, sessionId, verifiedCheckout }
}

/** Send the browser to Checkout. On web this unloads the page. */
export function redirectToCheckout(url: string): void {
  if (typeof window !== 'undefined') window.location.href = url
}

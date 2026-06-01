// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate referral landing route: `/r/<code>`.
 *
 * This is the in-app handler for shareable referral links built by
 * `buildReferralLink` (apps/mobile/lib/affiliate-api.ts). On web it sets
 * the two first-party attribution cookies that the signup hook
 * (apps/api/src/auth.ts `user.create.after`) reads:
 *
 *   - `__shogo_ref`          → the affiliate code
 *   - `__shogo_ref_visitor`  → a stable visitor UUID
 *
 * It then best-effort records the click (POST /api/affiliates/visit) for
 * the dashboard's "Clicks (30d)" stat and redirects to sign-up. Because
 * the link points at this same app's origin (per environment), it always
 * resolves — no more Expo "Unmatched Route".
 */
import { useEffect, useRef } from 'react'
import { View, ActivityIndicator, Platform } from 'react-native'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { API_URL } from '../../lib/api'

const REF_COOKIE = '__shogo_ref'
const VISITOR_COOKIE = '__shogo_ref_visitor'
// Mirrors SHOGO_AFFILIATE_COOKIE_DAYS (server default). The server's
// attribution lookup enforces its own expiry, so this only needs to be
// long enough to outlive a browse-then-signup session.
const COOKIE_MAX_AGE_SECONDS = 60 * 24 * 60 * 60

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function setCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return
  document.cookie =
    `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`
}

function newVisitorId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through to manual generation
  }
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

export default function AffiliateReferralRedirect() {
  const router = useRouter()
  const { code } = useLocalSearchParams<{ code?: string }>()
  const ran = useRef(false)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (ran.current) return
    ran.current = true

    const refCode = (Array.isArray(code) ? code[0] : code)?.trim()
    if (refCode) {
      const visitorId = readCookie(VISITOR_COOKIE) ?? newVisitorId()
      setCookie(VISITOR_COOKIE, visitorId)
      setCookie(REF_COOKIE, refCode)

      // Best-effort click recording; never block the redirect on it.
      void fetch(`${API_URL}/api/affiliates/visit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: refCode, visitorId }),
        keepalive: true,
      }).catch(() => undefined)
    }

    router.replace('/(auth)/sign-up')
  }, [code, router])

  // Native (deep link): no cookies to set, just send them to sign-up.
  if (Platform.OS !== 'web') {
    return <Redirect href="/(auth)/sign-up" />
  }

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator />
    </View>
  )
}

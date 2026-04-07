// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo_attribution'
const LANDING_KEY = 'shogo_landing_page'

export interface Attribution {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referrer?: string
  landingPage?: string
}

export function captureAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  if (safeGetItem(STORAGE_KEY)) return

  const params = new URLSearchParams(window.location.search)
  const data: Attribution = {
    utmSource: params.get('utm_source') || undefined,
    utmMedium: params.get('utm_medium') || undefined,
    utmCampaign: params.get('utm_campaign') || undefined,
    utmContent: params.get('utm_content') || undefined,
    utmTerm: params.get('utm_term') || undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname + window.location.search,
  }

  safeSetItem(STORAGE_KEY, JSON.stringify(data))
}

export function getStoredAttribution(): Attribution | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    const raw = safeGetItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Attribution
  } catch {
    return null
  }
}

export function clearStoredAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  safeRemoveItem(STORAGE_KEY)
  safeRemoveItem(LANDING_KEY)
}

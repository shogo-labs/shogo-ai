/**
 * Hotjar / Contentsquare Integration
 *
 * Hotjar is now part of Contentsquare. This module handles:
 * 1. Contentsquare tracking tag (dynamically injected, async)
 * 2. Hotjar SDK for user identification and custom events
 *
 * Both are gated behind VITE_HOTJAR_SITE_ID — nothing loads without it.
 * This keeps dev/test environments clean and analytics-free by default.
 *
 * Configuration:
 * - Set VITE_HOTJAR_SITE_ID in your .env.local file
 *
 * Usage:
 * - Call `initHotjar()` once at app startup (in main.tsx)
 * - Call `identifyHotjarUser()` after user authentication to associate sessions
 * - Call `trackHotjarEvent()` to track custom events
 */

import Hotjar from '@hotjar/browser'

const HOTJAR_VERSION = 6 // Hotjar snippet version (always 6)

/** Contentsquare tracking tag URL for project 612404 */
const CONTENTSQUARE_TAG_URL = 'https://t.contentsquare.net/uxa/25e2d049949b6.js'

/**
 * Inject the Contentsquare tracking script into the page.
 * Uses async loading to avoid blocking page render.
 * Only injects once, guarded by a data attribute check.
 */
function loadContentsquareTag(): void {
  // Prevent duplicate injection
  if (document.querySelector('script[data-cs-tag]')) return

  const script = document.createElement('script')
  script.src = CONTENTSQUARE_TAG_URL
  script.async = true
  script.dataset.csTag = 'true'
  document.head.appendChild(script)
}

/**
 * Initialize Hotjar + Contentsquare tracking.
 * Only activates when VITE_HOTJAR_SITE_ID is set.
 * Safe to call in any environment — it's a no-op without the env var.
 */
export function initHotjar(): void {
  const siteId = import.meta.env.VITE_HOTJAR_SITE_ID

  if (!siteId) {
    if (import.meta.env.DEV) {
      console.debug('[Hotjar] Skipped — VITE_HOTJAR_SITE_ID not set')
    }
    return
  }

  const numericSiteId = parseInt(siteId, 10)

  if (isNaN(numericSiteId)) {
    console.warn('[Hotjar] Invalid VITE_HOTJAR_SITE_ID — must be a number')
    return
  }

  try {
    // 1. Load Contentsquare tag (session replay, heatmaps)
    loadContentsquareTag()

    // 2. Initialize Hotjar SDK (user identification, custom events)
    Hotjar.init(numericSiteId, HOTJAR_VERSION)

    if (import.meta.env.DEV) {
      console.log(`[Hotjar/Contentsquare] ✅ Initialized with site ID: ${numericSiteId}`)
    }
  } catch (error) {
    console.warn('[Hotjar] Failed to initialize:', error)
  }
}

/**
 * Identify the current user in Hotjar/Contentsquare.
 * Call this after the user logs in to link session recordings to user profiles.
 *
 * NOTE: Do NOT send PII (email, phone) here — only opaque IDs and display names.
 * Sending PII to third-party analytics requires explicit GDPR consent.
 *
 * @param userId - Unique user ID
 * @param attributes - Optional non-PII user attributes for filtering
 */
export function identifyHotjarUser(
  userId: string,
  attributes?: Record<string, string | number | boolean>
): void {
  const siteId = import.meta.env.VITE_HOTJAR_SITE_ID

  if (!siteId) return

  try {
    Hotjar.identify(userId, attributes ?? {})
    if (import.meta.env.DEV) {
      console.log(`[Hotjar/Contentsquare] ✅ User identified: ${userId}`)
    }
  } catch (error) {
    console.warn('[Hotjar] Failed to identify user:', error)
  }
}

/**
 * Trigger a Hotjar/Contentsquare event (for funnels and user attribute tracking).
 *
 * @param eventName - Name of the event
 */
export function trackHotjarEvent(eventName: string): void {
  const siteId = import.meta.env.VITE_HOTJAR_SITE_ID

  if (!siteId) return

  try {
    Hotjar.event(eventName)
  } catch (error) {
    console.warn('[Hotjar] Failed to track event:', error)
  }
}

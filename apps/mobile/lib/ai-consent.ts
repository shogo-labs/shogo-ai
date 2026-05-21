// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AI Data-Sharing Consent (App Store guideline 5.1.1(i) / 5.1.2(i))
 *
 * iOS-only. Android and web are no-ops — every exported function short-
 * circuits when Platform.OS !== "ios". Google Play has no equivalent
 * disclosure requirement, and the web build never sends prompts directly
 * from the browser. Keeping the gate iOS-only avoids gratuitous UX
 * friction on platforms that don't need it.
 *
 * Apple requires a pre-first-message disclosure that:
 *   - Names every third-party AI provider that receives user data.
 *   - Lists exactly what data leaves the device.
 *   - Obtains explicit, revocable consent before sending.
 *
 * This module is the single source of truth for whether the consent has
 * been granted on the current device and for the list of providers shown
 * to the user. Update AI_PROVIDERS whenever a new model vendor is added
 * to the backend so the disclosure stays accurate.
 *
 * Storage: expo-secure-store (iOS keychain — survives app reinstall).
 *
 * The decision is also POST'd to /api/me/ai-consent so the server has an
 * auditable record (timestamp + version) — required by 5.1.2(i) ("identify
 * in the privacy policy ... all uses of that data") and useful for App
 * Review evidence.
 */

import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import { API_URL } from "./api"

const STORAGE_KEY = "ai_data_sharing_consent_v1"

/**
 * Bump this when the disclosure copy materially changes (new provider added,
 * new data category, etc.). A bump invalidates the stored consent and forces
 * the user to re-accept on next app open.
 */
export const AI_CONSENT_VERSION = 1

export type AiProvider = {
  name: string
  purpose: string
  privacyUrl: string
}

export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    name: "Anthropic (Claude)",
    purpose: "Generates chat responses and powers agent reasoning.",
    privacyUrl: "https://www.anthropic.com/legal/privacy",
  },
  {
    name: "OpenAI (GPT)",
    purpose: "Generates chat responses for selected models.",
    privacyUrl: "https://openai.com/policies/privacy-policy",
  },
] as const

export const DATA_SENT = [
  "Your prompt text and conversation history",
  "Files, images, or screenshots you attach",
  "Your selected model and language preference",
] as const

export const DATA_NOT_SENT = [
  "Your account email or password",
  "Payment or billing information",
  "Device identifiers or contacts",
] as const

export const PRIVACY_POLICY_URL = "https://shogo.ai/privacy"

type ConsentRecord = {
  acceptedAt: string // ISO8601
  version: number
}

/** True iff we are running on iOS — the only platform that prompts. */
function isIos(): boolean {
  return Platform.OS === "ios"
}

async function readRaw(): Promise<string | null> {
  if (!isIos()) return null
  try {
    return await SecureStore.getItemAsync(STORAGE_KEY)
  } catch {
    return null
  }
}

async function writeRaw(value: string): Promise<void> {
  if (!isIos()) return
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, value)
  } catch {
    // Storage failures are non-fatal — the in-session consent still
    // gates the chat UI for this app session.
  }
}

async function clearRaw(): Promise<void> {
  if (!isIos()) return
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export async function getAiConsent(): Promise<ConsentRecord | null> {
  if (!isIos()) return null
  const raw = await readRaw()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ConsentRecord
    if (typeof parsed?.acceptedAt !== "string" || typeof parsed?.version !== "number") {
      return null
    }
    if (parsed.version !== AI_CONSENT_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * iOS: true once the user has tapped "Allow" at the current consent version.
 * Android / web: always true — no prompt is shown on those platforms.
 */
export async function hasAcceptedAiConsent(): Promise<boolean> {
  if (!isIos()) return true
  const record = await getAiConsent()
  return record !== null
}

export async function acceptAiConsent(): Promise<ConsentRecord | null> {
  if (!isIos()) return null
  const record: ConsentRecord = {
    acceptedAt: new Date().toISOString(),
    version: AI_CONSENT_VERSION,
  }
  await writeRaw(JSON.stringify(record))

  // Mirror to server for audit + cross-device persistence. Best-effort —
  // a network failure here does not block the user.
  fetch(`${API_URL}/api/me/ai-consent`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  }).catch(() => {
    // ignore — local consent still gates the UI
  })

  return record
}

export async function revokeAiConsent(): Promise<void> {
  if (!isIos()) return
  await clearRaw()
  fetch(`${API_URL}/api/me/ai-consent`, {
    method: "DELETE",
    credentials: "include",
  }).catch(() => {
    // ignore
  })
}

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * AI Data-Sharing Consent (App Store guideline 5.1.1(i) / 5.1.2(i))
 *
 * Cross-platform. Before the first outbound message of a session, the chat
 * surface asks the user to explicitly allow transmitting prompt content to
 * the third-party AI provider they have selected. The same gate runs on
 * iOS, Android, and web — Apple's guideline is what triggered this, but
 * consistent UX across platforms also avoids the per-platform divergence
 * that contributed to the original rejection.
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
 * Storage:
 *   - Native (iOS / Android): expo-secure-store (Keychain / Keystore).
 *   - Web: safeGetItem / safeSetItem (localStorage with in-memory fallback).
 */

import { Platform } from "react-native"
import * as SecureStore from "expo-secure-store"
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage"

const STORAGE_KEY = "ai_data_sharing_consent_v2"

/**
 * Bump this when the disclosure copy materially changes (new provider added,
 * new data category, etc.). A bump invalidates the stored consent and forces
 * the user to re-accept on next chat. v2 added Google (Gemini) and Apple's
 * "same or equal protection" language to the disclosure body.
 */
export const AI_CONSENT_VERSION = 2

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
  {
    name: "Google (Gemini)",
    purpose: "Generates chat responses for selected models.",
    privacyUrl: "https://policies.google.com/privacy",
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
  "Device identifiers, contacts, or location",
] as const

export const PRIVACY_POLICY_URL = "https://shogo.ai/privacy"

type ConsentRecord = {
  acceptedAt: string // ISO8601
  version: number
}

async function readRaw(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      return safeGetItem(STORAGE_KEY)
    }
    return await SecureStore.getItemAsync(STORAGE_KEY)
  } catch {
    return null
  }
}

async function writeRaw(value: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      safeSetItem(STORAGE_KEY, value)
      return
    }
    await SecureStore.setItemAsync(STORAGE_KEY, value)
  } catch {
    // Storage failures are non-fatal — the in-session consent still
    // gates the chat UI for this app session.
  }
}

async function clearRaw(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      safeRemoveItem(STORAGE_KEY)
      return
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export async function getAiConsent(): Promise<ConsentRecord | null> {
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
 * True once the user has tapped "Allow" at the current consent version on
 * this device. Runs identically on iOS, Android, and web.
 */
export async function hasAcceptedAiConsent(): Promise<boolean> {
  const record = await getAiConsent()
  return record !== null
}

export async function acceptAiConsent(): Promise<ConsentRecord> {
  const record: ConsentRecord = {
    acceptedAt: new Date().toISOString(),
    version: AI_CONSENT_VERSION,
  }
  await writeRaw(JSON.stringify(record))
  return record
}

export async function revokeAiConsent(): Promise<void> {
  await clearRaw()
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared types for the voice module.
 *
 * The SDK does NOT own Prisma migrations. The consumer supplies their own
 * persistence layer via {@link CompanionStore}; this interface just documents
 * the fields we read/write.
 */

import type { Expressivity, VoiceSettings } from './audioTags.js'

/**
 * The persistent representation of a user's voice companion.
 *
 * Consumers typically back this with a Prisma model named `Companion` (or
 * whatever they choose) with one row per user.
 */
export interface Companion {
  /** Stable id (matches user id in single-companion apps). */
  id: string
  /** The authenticated user's id that owns this companion. */
  userId: string
  /** ElevenLabs convai agent id returned by `createAgent`. */
  agentId: string | null
  /** Human-facing name of the end user (used in agent greeting). */
  displayName: string
  /** The companion's own name / persona. */
  characterName: string
  /** ElevenLabs voice id. */
  voiceId: string
  /** Base system prompt authored by the app (without memory/expressivity blocks). */
  systemPrompt: string
  /** First line the agent speaks when the session starts. */
  firstMessage: string
  /** `off` | `subtle` | `full` — controls whether the expressivity block is injected. */
  expressivity: Expressivity
  /** Allow-list of audio tags the agent may use (empty ⇒ DEFAULT_ALLOWED_TAGS). */
  audioTags: string[]
  /** Optional ElevenLabs voice settings override. */
  voiceSettings: VoiceSettings | null
  /** Optional TTS model override (e.g. `eleven_turbo_v2_5`). */
  ttsModelId: string | null
}

/**
 * Consumer-supplied persistence layer. The SDK only calls these methods from
 * the server handlers; it never reaches into a database directly.
 */
export interface CompanionStore {
  findByUserId(userId: string): Promise<Companion | null>
  create(data: Omit<Companion, 'id'> & { id?: string }): Promise<Companion>
  update(userId: string, patch: Partial<Companion>): Promise<Companion>
  delete(userId: string): Promise<void>
}

/**
 * The shape required of the authenticated user. Consumers pass a `getUser`
 * function to `createVoiceHandlers` that returns this (or `null`).
 */
export interface VoiceUser {
  id: string
}

/**
 * Minimal interface the voice server needs from a memory backend. Matches
 * {@link import('../memory').MemoryStore.search} so consumers can wire the
 * SDK's MemoryStore directly.
 */
export interface VoiceMemoryStore {
  search(query: string, options: { limit: number }): ReadonlyArray<{ chunk: string; matchType?: string }>
}

/** Shape of the JSON body for `POST /voice/agent` (create). */
export interface CreateCompanionBody {
  displayName: string
  characterName: string
  voiceId: string
  systemPrompt: string
  firstMessage: string
  expressivity?: Expressivity
  audioTags?: string[]
  voiceSettings?: VoiceSettings
  ttsModelId?: string
}

/** Shape of the JSON body for `PATCH /voice/agent`. Every field is optional. */
export type PatchCompanionBody = Partial<CreateCompanionBody>

/** Shape of the JSON body for `POST /voice/tts-preview`. */
export interface TtsPreviewBody {
  voiceId: string
  text?: string
  audioTags?: string[]
  modelId?: string
  voiceSettings?: VoiceSettings
  characterName?: string
}

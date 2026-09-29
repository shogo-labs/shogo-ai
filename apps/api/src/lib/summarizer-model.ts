// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Context-compaction summarizer model resolution.
 *
 * Agent runtimes summarize older conversation history when a session nears
 * its context limit. The model they use is a platform-wide super-admin
 * choice, stored as a single PlatformSetting row (`summarizer.model`, managed
 * from the admin AI settings page).
 *
 * Unset defaults to `DEFAULT_ASSISTANT_MODEL` (Hoshi 2.0). The resolved model
 * id + provider is injected into runtimes as `AGENT_SUMMARIZER_MODEL` via
 * `lib/runtime/agent-model-defaults.ts`, and served to cloud-connected
 * desktops through `/api/platform/agent-model-defaults`.
 *
 * The row is re-read at most every `CACHE_TTL_MS`, so an admin change reaches
 * every API replica, not just the one that handled the PUT.
 */
import { prisma } from './prisma'
import { DEFAULT_ASSISTANT_MODEL } from './resolve-language-model'

/** Default model id used when no admin override is configured (Hoshi 2.0). */
export const DEFAULT_SUMMARIZER_MODEL_ID = DEFAULT_ASSISTANT_MODEL

/** PlatformSetting key holding the admin-selected summarizer model id. */
export const SUMMARIZER_MODEL_SETTING_KEY = 'summarizer.model'

const CACHE_TTL_MS = 30_000

let cached: { id: string | null; loadedAt: number } | null = null

function normalize(id: string | null | undefined): string | null {
  const trimmed = (id ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Record a value this process just wrote, so it applies without waiting for the TTL. */
export function setSummarizerModelId(id: string | null | undefined): void {
  cached = { id: normalize(id), loadedAt: Date.now() }
}

/** The admin-configured model id, or the default (Hoshi 2.0) when unset. */
export async function getSummarizerModelId(): Promise<string> {
  if (!cached || Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    try {
      const row = await (prisma as any).platformSetting?.findUnique({
        where: { key: SUMMARIZER_MODEL_SETTING_KEY },
      })
      cached = { id: normalize(row?.value), loadedAt: Date.now() }
    } catch (err: any) {
      console.warn('[SummarizerModel] Could not read setting; using last known value:', err?.message ?? err)
      cached = { id: cached?.id ?? null, loadedAt: Date.now() }
    }
  }
  return cached?.id ?? DEFAULT_SUMMARIZER_MODEL_ID
}

/** Test-only: drop the cache so the next read hits the database. */
export function _resetSummarizerModelCache(): void {
  cached = null
}

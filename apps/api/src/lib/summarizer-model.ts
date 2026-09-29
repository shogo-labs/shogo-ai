// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Context-compaction summarizer model resolution.
 *
 * Agent runtimes summarize older conversation history when a session nears
 * its context limit. The model they use is a platform-wide super-admin
 * choice, stored as a single PlatformSetting row (`summarizer.model`, managed
 * from the admin AI settings page), mirroring `lib/title-model.ts`'s pattern.
 *
 * Unset defaults to `DEFAULT_ASSISTANT_MODEL` (Hoshi 2.0). The resolved model
 * id + provider is injected into runtimes as `AGENT_SUMMARIZER_MODEL` via
 * `lib/runtime/agent-model-defaults.ts`, and served to cloud-connected
 * desktops through `/api/platform/agent-model-defaults`.
 */
import { DEFAULT_ASSISTANT_MODEL } from './resolve-language-model'

/** Default model id used when no admin override is configured (Hoshi 2.0). */
export const DEFAULT_SUMMARIZER_MODEL_ID = DEFAULT_ASSISTANT_MODEL

/** PlatformSetting key holding the admin-selected summarizer model id. */
export const SUMMARIZER_MODEL_SETTING_KEY = 'summarizer.model'

let configuredSummarizerModelId: string | null = null

/** Update the in-memory configured model id (called at boot + after admin PUT). */
export function setSummarizerModelId(id: string | null | undefined): void {
  const trimmed = (id ?? '').trim()
  configuredSummarizerModelId = trimmed.length > 0 ? trimmed : null
}

/** The admin-configured model id, or the default (Hoshi 2.0) when unset. */
export function getSummarizerModelId(): string {
  return configuredSummarizerModelId ?? DEFAULT_SUMMARIZER_MODEL_ID
}

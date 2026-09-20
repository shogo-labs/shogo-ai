// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Personal-companion model resolution.
 *
 * The personal companion hides its model picker from end users — one
 * companion per person, not a per-conversation choice (see
 * `useWorkspaceExperience`'s `showModelPicker: !isPersonal` in
 * `packages/shared-app/src/hooks/useWorkspaceExperience.ts`). So the model it
 * runs on for interactive chat is a platform-wide super-admin choice, stored
 * as a single PlatformSetting row (`personal-companion.model`, managed from
 * the admin settings page), mirroring `lib/title-model.ts`'s pattern.
 *
 * Unset defaults to `DEFAULT_ASSISTANT_MODEL` (Hoshi 2.0) — the same default
 * already used platform-wide for title generation and the in-app assistant —
 * so a fresh install/deploy needs no manual seeding to get the intended
 * default; a super admin only needs to act to override it.
 *
 * Applied in `routes/workspace-chat.ts` for workspaces of kind `'personal'`:
 * it overrides whatever `agentMode` the client sent and is intentionally
 * exempt from the advanced-model-access tier gate (this is an explicit admin
 * decision, not a user-initiated premium-model pick).
 */
import { DEFAULT_ASSISTANT_MODEL } from './resolve-language-model'

/** Default model id used when no admin override is configured (Hoshi 2.0). */
export const DEFAULT_PERSONAL_COMPANION_MODEL_ID = DEFAULT_ASSISTANT_MODEL

/** PlatformSetting key holding the admin-selected personal-companion model id. */
export const PERSONAL_COMPANION_MODEL_SETTING_KEY = 'personal-companion.model'

let configuredPersonalCompanionModelId: string | null = null

/** Update the in-memory configured model id (called at boot + after admin PUT). */
export function setPersonalCompanionModelId(id: string | null | undefined): void {
  const trimmed = (id ?? '').trim()
  configuredPersonalCompanionModelId = trimmed.length > 0 ? trimmed : null
}

/** The admin-configured model id, or the default (Hoshi 2.0) when unset. */
export function getPersonalCompanionModelId(): string {
  return configuredPersonalCompanionModelId ?? DEFAULT_PERSONAL_COMPANION_MODEL_ID
}

/** The raw configured override, or `null` when unset (for surfacing "unset" in admin UI). */
export function getPersonalCompanionModelOverride(): string | null {
  return configuredPersonalCompanionModelId
}

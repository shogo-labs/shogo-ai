// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which channel types a workspace may bring its own credentials for.
 *
 * Personal workspaces connect Telegram/WhatsApp/Slack through a
 * Shogo-managed flow, not by pasting a bot token / phone-number ID — and the
 * agent runtime strips their `channel_connect` tool accordingly (see
 * `CAPABILITY_PROFILES.personal.disabledToolNames` in
 * `packages/agent-runtime/src/capability-profiles.ts`). The Channels panel
 * mirrors that boundary here so the UI never shows a BYO form for a channel
 * the workspace can't actually connect that way.
 *
 * Kept dependency-free so it can be unit-tested without the RN component
 * tree, and so it is the single list the panel and its tests share.
 */

export type CapabilityProfile = 'personal' | 'team'

/** Channel types replaced by a managed connection in the personal profile. */
export const PERSONAL_MANAGED_CHANNEL_TYPES = ['telegram', 'whatsapp', 'slack'] as const

/** True when `type` is a bring-your-own-credential channel for this profile. */
export function isManagedChannelForProfile(type: string, profile: CapabilityProfile): boolean {
  return (
    profile === 'personal' &&
    (PERSONAL_MANAGED_CHANNEL_TYPES as readonly string[]).includes(type)
  )
}

/** Channel types the panel should render a configurable row for. */
export function visibleChannelTypesForProfile<T extends string>(
  all: readonly T[],
  profile: CapabilityProfile,
): T[] {
  return all.filter((type) => !isManagedChannelForProfile(type, profile))
}

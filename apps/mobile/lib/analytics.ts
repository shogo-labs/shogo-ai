// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type PostHog from 'posthog-react-native'

export const EVENTS = {
  CHAT_MESSAGE_SENT: 'chat_message_sent',
  CHAT_STREAM_STOPPED: 'chat_stream_stopped',
  PROJECT_CREATED: 'project_created',
  ONBOARDING_STEP_VIEWED: 'onboarding_step_viewed',
  ONBOARDING_COMPLETED: 'onboarding_completed',
  ONBOARDING_INTENT_SELECTED: 'onboarding_intent_selected',
  // SHO-614: what the marketing link asked for, reported once onboarding
  // resolves it (the URL, or the account's copy for a second device).
  SIGNUP_INTENT_CAPTURED: 'signup_intent_captured',
  ONBOARDING_TEAM_SETUP_COMPLETED: 'onboarding_team_setup_completed',
  ONBOARDING_PERMISSION_RESULT: 'onboarding_permission_result',
  GETTING_STARTED_ITEM_CLICKED: 'getting_started_item_clicked',
  GETTING_STARTED_DISMISSED: 'getting_started_dismissed',
  WORKSPACE_CREATED: 'workspace_created',
  WORKSPACE_SWITCHED: 'workspace_switched',
  UPGRADE_CLICKED: 'upgrade_clicked',
  // Activation signals (SHO-258 §§2,7): mirrored server-side as
  // users.firstCapHitAt / firstPreviewSeenAt + the Loops `hit_cap` event.
  USAGE_LIMIT_HIT: 'hit_cap',
  PREVIEW_SEEN: 'preview_seen',
  SIGN_OUT: 'sign_out',
  SCREEN_VIEW: '$screen',
} as const

export function trackEvent(
  posthog: PostHog | null | undefined,
  event: string,
  properties?: Record<string, unknown>,
) {
  posthog?.capture(event, properties)
}

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
  ONBOARDING_TEAM_SETUP: 'onboarding_team_setup',
  ONBOARDING_AGENT_SELECTED: 'onboarding_agent_selected',
  GETTING_STARTED_ITEM_CLICKED: 'getting_started_item_clicked',
  GETTING_STARTED_DISMISSED: 'getting_started_dismissed',
  WORKSPACE_CREATED: 'workspace_created',
  WORKSPACE_SWITCHED: 'workspace_switched',
  UPGRADE_CLICKED: 'upgrade_clicked',
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

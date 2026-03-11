// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type PostHog from 'posthog-react-native'

export const EVENTS = {
  CHAT_MESSAGE_SENT: 'chat_message_sent',
  CHAT_STREAM_STOPPED: 'chat_stream_stopped',
  PROJECT_CREATED: 'project_created',
  ONBOARDING_STEP_VIEWED: 'onboarding_step_viewed',
  ONBOARDING_COMPLETED: 'onboarding_completed',
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

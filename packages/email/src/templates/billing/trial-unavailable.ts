// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * Sent when a trial checkout is cancelled because the card or account already
 * used a free trial, or because the card is prepaid (see
 * apps/api/src/services/email.service.ts `sendTrialUnavailableEmail`). Nothing
 * was charged. `reasonMessage` carries the explanation for the specific
 * `reason` so the owner knows what to do next.
 */
export const trialUnavailableTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  dashboardUrl: string
  reason?: string | null
  reasonMessage?: string
  appName: string
}> = {
  name: 'trial-unavailable',
  subject: 'Your {{workspaceName}} trial could not be started',
  html: wrapInLayout(`
    <h1 class="email-h1">We couldn't start your free trial</h1>
    <p class="email-text">
      We cancelled the trial checkout for <strong>{{workspaceName}}</strong>
      ({{planName}} plan). <strong>Nothing was charged.</strong>
    </p>
    <p class="email-text">{{reasonMessage}}</p>
    <a href="{{dashboardUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Go to billing</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you think this is a mistake, reply to this email or contact support.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    reasonMessage: 'This card or account has already used a free trial. You can still subscribe without a trial.',
  },
}

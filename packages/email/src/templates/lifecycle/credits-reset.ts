// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * "Your agent is back" — sent once per cap, after an exhausted 5-hour window
 * reopens (SHO-258 §4). Pairs with the in-app `credits_reset` notification and
 * a push, and closes the loop the cap notice opens ("back at HH:MM").
 */
export const creditsResetTemplate: EmailTemplate<{
  name?: string
  projectName: string
  resetAt: string
  continueUrl: string
  preferencesUrl: string
  appName: string
}> = {
  name: 'credits-reset',
  subject: 'Your agent is back — pick up {{projectName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Your agent is back</h1>
    <p class="email-text">
      Your usage limit reset at <strong>{{resetAt}}</strong>, so
      <strong>{{projectName}}</strong> can keep going.
    </p>
    <a href="{{continueUrl}}" class="email-btn">Continue where you left off</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're getting this once because you hit a limit and left.
      <a href="{{preferencesUrl}}">Turn these emails off</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}

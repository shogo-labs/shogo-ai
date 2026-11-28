// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * The 6-digit sign-in code (SHO-613).
 *
 * A code, not a link: this is the sign-in path offered inside Instagram's and
 * Facebook's in-app browsers, where Google's OAuth is refused. A link would
 * open in the phone's mail app's browser — a different browser from the one the
 * visitor is in — so the session would be created somewhere they are not
 * looking. The code is typed back into the page the ad opened.
 *
 * The number is the whole message, so it is the largest thing in it.
 */
export const emailOtpTemplate: EmailTemplate<{
  appName: string
  otp: string
  expiresIn: string
}> = {
  name: 'email-otp',
  subject: 'Your {{appName}} code: {{otp}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Your sign-in code</h1>
    <p class="email-text">Enter this code on the {{appName}} page you have open:</p>
    <p style="font-size:34px;line-height:42px;font-weight:700;letter-spacing:8px;margin:24px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">{{otp}}</p>
    <p class="email-muted">This code expires in {{expiresIn}} and works once.</p>
    <p class="email-muted">
      If you didn't ask for it, you can ignore this email — nobody can sign in
      without it.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    expiresIn: '10 minutes',
  },
}

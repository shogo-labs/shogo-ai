// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const welcomeTemplate: EmailTemplate<{
  name: string
  appName: string
  loginUrl?: string
}> = {
  name: 'welcome',
  subject: 'Welcome to {{appName}}!',
  html: wrapInLayout(`
    <h1 class="email-h1">Welcome to {{appName}}!</h1>
    <p class="email-text">Hi {{name}},</p>
    <p class="email-text">
      Thanks for signing up. You now have access to build, deploy, and
      collaborate on AI-powered apps — all from one place.
    </p>
    <a href="{{loginUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Get Started</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you have any questions, just reply to this email — we're happy to help.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    loginUrl: EMAIL_CONSTANTS.APP_URL,
  },
}

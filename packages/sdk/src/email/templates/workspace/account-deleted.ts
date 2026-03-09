// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const accountDeletedTemplate: EmailTemplate<{
  name?: string
  email: string
  appName: string
}> = {
  name: 'account-deleted',
  subject: 'Your {{appName}} account has been deleted',
  html: wrapInLayout(`
    <h1 class="email-h1">Account Deleted</h1>
    <p class="email-text">
      Your {{appName}} account associated with <strong>{{email}}</strong>
      has been permanently deleted. All your data, workspaces, and projects
      have been removed.
    </p>
    <p class="email-text">
      If you ever want to come back, you can create a new account at any
      time.
    </p>
    <hr class="email-divider">
    <p class="email-muted">
      If you didn't request this deletion, please contact us immediately
      by replying to this email.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}

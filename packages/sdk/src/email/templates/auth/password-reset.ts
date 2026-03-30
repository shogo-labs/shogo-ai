// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const passwordResetTemplate: EmailTemplate<{
  name?: string
  appName: string
  resetUrl: string
  expiresIn?: string
}> = {
  name: 'password-reset',
  subject: 'Reset your {{appName}} password',
  html: wrapInLayout(`
    <h1 class="email-h1">Reset Your Password</h1>
    <p class="email-text">
      We received a request to reset the password for your account.
      Click the button below to choose a new one:
    </p>
    <a href="{{resetUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Reset Password</a>
    <hr class="email-divider">
    <p class="email-muted">This link expires in {{expiresIn}}.</p>
    <p class="email-muted">
      If you didn't request this, you can safely ignore this email.
      Your password will remain unchanged.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    expiresIn: '1 hour',
  },
}

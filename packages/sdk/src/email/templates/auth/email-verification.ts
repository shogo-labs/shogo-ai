// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const emailVerificationTemplate: EmailTemplate<{
  name?: string
  appName: string
  verifyUrl: string
  expiresIn?: string
}> = {
  name: 'email-verification',
  subject: 'Verify your email for {{appName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Verify Your Email</h1>
    <p class="email-text">
      Please confirm your email address by clicking the button below.
      This helps us keep your account secure.
    </p>
    <a href="{{verifyUrl}}" class="email-btn">Verify Email</a>
    <hr class="email-divider">
    <p class="email-muted">This link expires in {{expiresIn}}.</p>
    <p class="email-muted">
      If you didn't create an account, you can safely ignore this email.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    expiresIn: '24 hours',
  },
}

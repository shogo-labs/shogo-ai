// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const paymentActionRequiredTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  confirmUrl: string
  appName: string
}> = {
  name: 'payment-action-required',
  subject: 'Confirm your payment for {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Confirm Your Payment</h1>
    <p class="email-text">
      Your bank needs you to confirm the payment of <strong>{{currency}}{{amount}}</strong>
      for <strong>{{workspaceName}}</strong> ({{planName}}). Nothing has been charged yet.
    </p>
    <p class="email-text">
      This is a routine security check some banks require for recurring and
      online payments. It only takes a moment.
    </p>
    <a href="{{confirmUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Confirm Payment</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you didn't expect this charge, please reply to this email or
      contact support.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    currency: '$',
  },
}

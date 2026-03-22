// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const paymentFailedTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  retryUrl: string
  appName: string
}> = {
  name: 'payment-failed',
  subject: 'Payment failed for {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Payment Failed</h1>
    <p class="email-text">
      We were unable to process the payment of <strong>{{currency}}{{amount}}</strong>
      for <strong>{{workspaceName}}</strong> ({{planName}} plan).
    </p>
    <p class="email-text">
      Please update your payment method to keep your plan active and avoid
      any interruption to your workspace.
    </p>
    <a href="{{retryUrl}}" class="email-btn-danger">Update Payment Method</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you believe this is a mistake, please reply to this email or
      contact support.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    currency: '$',
  },
}

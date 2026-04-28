// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const planUpgradedTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  billingInterval?: string
  /** "1" or e.g. "5"; templated only when set. */
  seats?: string
  /** Total monthly included usage in USD, formatted (e.g. "$100"). */
  includedUsdTotal?: string
  dashboardUrl: string
  appName: string
}> = {
  name: 'plan-upgraded',
  subject: '{{workspaceName}} has been upgraded to {{planName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Plan Upgraded!</h1>
    <p class="email-text">
      Your workspace <strong>{{workspaceName}}</strong> is now on the
      <span class="email-badge">{{planName}}</span> plan.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="email-detail-label">Plan</td>
        <td class="email-detail-value" align="right">{{planName}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Billing</td>
        <td class="email-detail-value" align="right">{{billingInterval}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Seats</td>
        <td class="email-detail-value" align="right">{{seats}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Monthly included usage</td>
        <td class="email-detail-value" align="right">{{includedUsdTotal}}</td>
      </tr>
    </table>
    <p class="email-text" style="margin-top:18px;">
      Every AI request is billed at the provider's raw cost plus a flat 20% markup —
      no credits, no unit conversions. You can add or remove seats anytime from
      Settings &rarr; Billing; we prorate the change automatically.
    </p>
    <br>
    <a href="{{dashboardUrl}}" class="email-btn" style="color:#ffffff;text-decoration:none;">Go to Dashboard</a>
    <hr class="email-divider">
    <p class="email-muted">
      Manage your subscription anytime from Settings &rarr; Billing.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    billingInterval: 'Monthly',
    seats: '1',
  },
}

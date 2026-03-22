// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const planUpgradedTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  billingInterval?: string
  creditsTotal?: string
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
        <td class="email-detail-label">Monthly credits</td>
        <td class="email-detail-value" align="right">{{creditsTotal}}</td>
      </tr>
    </table>
    <br>
    <a href="{{dashboardUrl}}" class="email-btn">Go to Dashboard</a>
    <hr class="email-divider">
    <p class="email-muted">
      Manage your subscription anytime from Settings &rarr; Plans &amp; Credits.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    billingInterval: 'Monthly',
  },
}

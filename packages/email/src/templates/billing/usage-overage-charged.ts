// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * Sent when a mid-cycle usage-overage block is invoiced and charged (see
 * apps/api/src/services/billing.service.ts `chargeOverageBlocks`). This is a
 * heads-up so an on-demand charge never arrives unannounced — paired with an
 * in-app notification of type `overage_charged`.
 */
export const usageOverageChargedTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  amount: string
  currency?: string
  periodOverageUsd: string
  invoiceUrl?: string
  manageUrl: string
  appName: string
}> = {
  name: 'usage-overage-charged',
  subject: 'Usage charge of {{currency}}{{amount}} for {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">On-demand usage charged</h1>
    <p class="email-text">
      <strong>{{workspaceName}}</strong> has used more than its included monthly
      usage, so we charged an on-demand usage block. We bill these in blocks as
      you go rather than one large amount at the end of the period.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="email-detail-label">Charged now</td>
        <td class="email-detail-value" align="right">{{currency}}{{amount}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Overage this period</td>
        <td class="email-detail-value" align="right">{{currency}}{{periodOverageUsd}}</td>
      </tr>
    </table>
    <br>
    <a href="{{invoiceUrl}}" class="email-btn-outline">View invoice</a>
    <hr class="email-divider">
    <p class="email-text">
      Want to cap on-demand spend? You can set a monthly spending limit any time.
    </p>
    <a href="{{manageUrl}}" class="email-btn-outline">Set a spending limit</a>
    <p class="email-muted">
      If you have billing questions, reply to this email or contact support.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    currency: '$',
  },
}

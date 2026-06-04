// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * Proactive heads-up as a workspace approaches a usage boundary: either its
 * included monthly usage is nearly exhausted (on-demand overage is about to
 * begin) or it is nearing its configured monthly spending cap. Paired with an
 * in-app notification of type `usage_threshold`.
 *
 * `limitLabel` lets one template serve both cases ("included usage" vs
 * "spending cap") without conditional rendering, since the template engine
 * only does `{{var}}` substitution.
 */
export const usageApproachingLimitTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  currency?: string
  usedUsd: string
  limitUsd: string
  limitLabel: string
  percentUsed: string
  manageUrl: string
  appName: string
}> = {
  name: 'usage-approaching-limit',
  subject: 'Usage alert: {{workspaceName}} is at {{percentUsed}}% of its {{limitLabel}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Approaching your {{limitLabel}}</h1>
    <p class="email-text">
      <strong>{{workspaceName}}</strong> has used
      <strong>{{currency}}{{usedUsd}}</strong> of its
      <strong>{{currency}}{{limitUsd}}</strong> {{limitLabel}} this period
      (<strong>{{percentUsed}}%</strong>).
    </p>
    <p class="email-text">
      Once the included amount is used up, additional usage is billed on demand.
      You can review usage or set a monthly spending limit below.
    </p>
    <a href="{{manageUrl}}" class="email-btn">Review usage &amp; limits</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're receiving this because you're a billing admin for this workspace.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    currency: '$',
  },
}

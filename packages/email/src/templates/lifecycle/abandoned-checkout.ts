// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

/**
 * "Your {plan} {trial|upgrade} is one step away" — sent at most once per user per
 * plan, ever, when a Stripe Checkout session expires uncompleted (SHO-615). The
 * button uses Stripe's `after_expiration.recovery.url` (valid 30 days) so the
 * person lands back on a working session with their details filled in.
 *
 * `offerNoun` is "7-day trial" or "upgrade"; `intervalLabel` is "monthly" or
 * "annual". Passing the words (not a boolean) keeps the copy honest without a
 * conditional, which this template system does not have.
 */
export const abandonedCheckoutTemplate: EmailTemplate<{
  planName: string
  intervalLabel: string
  offerNoun: string
  resumeUrl: string
  unsubscribeUrl: string
  appName: string
}> = {
  name: 'abandoned-checkout',
  subject: 'Your {{planName}} {{offerNoun}} is one step away',
  html: wrapInLayout(`
    <h1 class="email-h1">Your {{planName}} {{offerNoun}} is one step away</h1>
    <p class="email-text">
      You started a {{intervalLabel}} <strong>{{planName}}</strong> {{offerNoun}} but
      didn't finish. Nothing was charged, and your details are saved.
    </p>
    <a href="{{resumeUrl}}" class="email-btn">Pick up where you left off</a>
    <hr class="email-divider">
    <p class="email-muted">
      You're getting this because you started a checkout and didn't complete it.
      <a href="{{unsubscribeUrl}}">Unsubscribe from these emails</a>.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Optional cloud integrations used by Better Auth hooks.
 *
 * Local sign-in does not send email or write cloud attribution events. The
 * local bundle therefore keeps Better Auth without SES/Stripe integration
 * code; cloud mode still loads the original services.
 *
 * The local implementation is typed against the real modules (type-only
 * imports, erased at build time) so its return shapes cannot drift.
 */
import type * as EmailModule from './email.service'
import type * as LoopsModule from './loops.service'
import type * as AffiliateModule from './affiliate.service'

type AuthIntegrations = Pick<
  typeof EmailModule,
  'sendWelcomeEmail' | 'sendPasswordResetEmail' | 'sendEmailVerificationEmail'
> &
  Pick<typeof LoopsModule, 'identifyUser' | 'trackEvent'> &
  Pick<typeof AffiliateModule, 'resolveAttributionForUser'>

let email: typeof EmailModule | null = null
let loops: typeof LoopsModule | null = null
let affiliate: typeof AffiliateModule | null = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  ;[email, loops, affiliate] = await Promise.all([
    import('./email.service'),
    import('./loops.service'),
    import('./affiliate.service'),
  ])
}

const emailDisabled = async () => ({ success: false, error: 'email integration disabled' })

export const localAuthIntegrations: AuthIntegrations = {
  sendWelcomeEmail: emailDisabled,
  sendPasswordResetEmail: emailDisabled,
  sendEmailVerificationEmail: emailDisabled,
  identifyUser: async () => {},
  trackEvent: async () => {},
  resolveAttributionForUser: async () => null,
}

// Looked up per call so tests that `mock.module()` a cloud service still reach the mock.
export const sendWelcomeEmail: AuthIntegrations['sendWelcomeEmail'] = (...args) =>
  (email ?? localAuthIntegrations).sendWelcomeEmail(...args)
export const sendPasswordResetEmail: AuthIntegrations['sendPasswordResetEmail'] = (...args) =>
  (email ?? localAuthIntegrations).sendPasswordResetEmail(...args)
export const sendEmailVerificationEmail: AuthIntegrations['sendEmailVerificationEmail'] = (...args) =>
  (email ?? localAuthIntegrations).sendEmailVerificationEmail(...args)
export const identifyUser: AuthIntegrations['identifyUser'] = (...args) =>
  (loops ?? localAuthIntegrations).identifyUser(...args)
export const trackEvent: AuthIntegrations['trackEvent'] = (...args) =>
  (loops ?? localAuthIntegrations).trackEvent(...args)
export const resolveAttributionForUser: AuthIntegrations['resolveAttributionForUser'] = (...args) =>
  (affiliate ?? localAuthIntegrations).resolveAttributionForUser(...args)

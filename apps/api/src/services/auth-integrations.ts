// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Optional cloud integrations used by Better Auth hooks.
 *
 * Local sign-in does not send email or write cloud attribution events. The
 * local bundle therefore keeps Better Auth without SES/Stripe integration
 * code; cloud mode still loads the original services.
 */
let email: any = null
let loops: any = null
let affiliate: any = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  ;[email, loops, affiliate] = await Promise.all([
    import(new URL('./email.service.ts', import.meta.url).href),
    import(new URL('./loops.service.ts', import.meta.url).href),
    import(new URL('./affiliate.service.ts', import.meta.url).href),
  ])
}

const emailDisabledResult = () => Promise.resolve({ success: false, error: 'email integration disabled' })

export const sendWelcomeEmail = (...args: any[]) => email?.sendWelcomeEmail?.(...args) ?? emailDisabledResult()
export const sendPasswordResetEmail = (...args: any[]) => email?.sendPasswordResetEmail?.(...args) ?? emailDisabledResult()
export const sendEmailVerificationEmail = (...args: any[]) =>
  email?.sendEmailVerificationEmail?.(...args) ?? emailDisabledResult()
export const identifyUser = (...args: any[]) => loops?.identifyUser?.(...args) ?? Promise.resolve()
export const trackEvent = (...args: any[]) => loops?.trackEvent?.(...args) ?? Promise.resolve()
export const resolveAttributionForUser = (...args: any[]) => affiliate?.resolveAttributionForUser?.(...args) ?? Promise.resolve(null)

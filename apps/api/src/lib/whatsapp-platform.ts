// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WhatsApp platform (Meta Tech Provider) availability helpers.
 *
 * The Embedded Signup flow requires three env vars to be set.
 * Without them the Connect with Meta button is hidden and the connect-link
 * route returns 412. On desktop the flag is derived from cloud-auth status
 * because the actual check happens on the cloud API.
 */

import { isShogoCloudAuthed } from './cloud-forwarding'

/** Returns true when this API instance can serve the Embedded Signup flow. */
export function whatsappEmbeddedSignupAvailable(): boolean {
  return !!(
    process.env.WHATSAPP_META_APP_ID &&
    process.env.WHATSAPP_META_APP_SECRET &&
    process.env.WHATSAPP_ES_CONFIG_ID
  )
}

/**
 * Returns the value of `features.whatsappEmbeddedSignup` to send to the client.
 * Cloud: based on actual env vars.
 * Desktop: based on whether the user is signed in to Shogo Cloud, because
 *          the real availability check happens on the cloud API.
 */
export function whatsappEmbeddedSignupFeatureFlag(localMode: boolean): boolean {
  if (localMode) return isShogoCloudAuthed()
  return whatsappEmbeddedSignupAvailable()
}

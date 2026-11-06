// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native release (App Store / Google Play). Every Expo call inside these modules
 * goes through `./client`, which is the single insert point for `api.expo.dev`.
 */

export * from './client'
export * from './eas-graphql'
export * from './apps.service'
export * from './credentials.service'
export * from './play'
export * from './signing.service'
export * from './release.service'
export * from './usage.service'
export * from './webhook'
export * from './poller'
export * from './alerts'

import { readPlayKey } from './credentials.service'
import { resolvePlayCredentials, type PlayKey } from './play'

/**
 * Just the credential resolution, for the state route: it needs the publisher
 * email to show the user which account to invite, without minting a Google token.
 */
export async function resolvePlayCredentialsFor(
  workspaceId: string,
): Promise<PlayKey | null> {
  const resolved = await resolvePlayCredentials(workspaceId, { readByokKey: readPlayKey })
  return resolved?.key ?? null
}

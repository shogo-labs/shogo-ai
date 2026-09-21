// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type ApiProfile = 'local' | 'cloud'

export function deriveApiProfile(env: Record<string, string | undefined> = process.env): ApiProfile {
  return env.SHOGO_LOCAL_MODE === 'true' ? 'local' : 'cloud'
}

export function isLocalApiProfile(env?: Record<string, string | undefined>): boolean {
  return deriveApiProfile(env) === 'local'
}

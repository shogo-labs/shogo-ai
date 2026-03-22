// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createAuthClient as createBetterAuthClient } from 'better-auth/react'

export interface AuthClientConfig {
  baseURL: string
  basePath?: string
}

export function createAuthClient(config: AuthClientConfig) {
  return createBetterAuthClient({
    baseURL: config.baseURL,
    basePath: config.basePath ?? '/api/auth',
  })
}

export type AuthClient = ReturnType<typeof createAuthClient>

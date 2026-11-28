// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createAuthClient as createBetterAuthClient } from 'better-auth/react'
import { emailOTPClient } from 'better-auth/client/plugins'

export interface AuthClientConfig {
  baseURL: string
  basePath?: string
}

export function createAuthClient(config: AuthClientConfig) {
  return createBetterAuthClient({
    baseURL: config.baseURL,
    basePath: config.basePath ?? '/api/auth',
    // Passwordless email sign-in (`emailOtp.sendVerificationOtp` /
    // `signIn.emailOtp`) — the path that works inside Instagram's webview
    // (SHO-613). The server half is the `emailOTP` plugin in apps/api/src/auth.ts.
    plugins: [emailOTPClient()],
  })
}

export type AuthClient = ReturnType<typeof createAuthClient>

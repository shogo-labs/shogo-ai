// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export { createAuthClient, type AuthClientConfig, type AuthClient } from './client'
export {
  SessionProvider,
  useSessionContext,
  useSession,
  type SessionProviderProps,
  type SessionContextValue,
  type SessionData,
  type UserRole,
} from './SessionProvider'
export {
  AuthProvider,
  useAuth,
  type AuthProviderProps,
  type AuthContextValue,
  type AuthUser,
} from './AuthProvider'

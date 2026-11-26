// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mobile Auth Context
 *
 * Thin wrapper around the shared AuthProvider from @shogo/shared-app.
 * Just provides the platform-specific auth client.
 */

import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { AuthProvider as SharedAuthProvider, useAuth, AuthRequestError, type AuthErrorContext } from '@shogo/shared-app/auth'
import { authClient } from '../lib/auth-client'
import { clearActiveWorkspaceId } from '../lib/workspace-store'
import { clearTeamChatCache } from '../lib/team-chat-cache'
import { clearChatHistory } from '../lib/chat-history-store'
import { clearWorkspaceChatsCache } from '../lib/workspace-chats-cache'
import { clearChatPanelMessageCache } from '../lib/chat-panel-message-cache'
import { clearAuthSessionCache, readCachedAuthUser, rememberAuthUser } from '../lib/auth-session-cache'
import { clearProjectsCache } from '../lib/projects-cache'

export { useAuth, useAuthOptional, getAuthUserSnapshot, type AuthUser, type AuthContextValue } from '@shogo/shared-app/auth'

function onSignOut(): void {
  clearActiveWorkspaceId()
  void clearTeamChatCache()
  // Chat history on the device and the in-memory transcript cache outlive a
  // session unless they are dropped here (SHO-260). `clearChatPanelMessageCache`
  // was exported for exactly this and had no caller.
  void clearChatHistory()
  // The workspace-agent chats list is likewise per user: the next account on
  // this device must not see the previous one's rows (SHO-391).
  void clearWorkspaceChatsCache()
  clearChatPanelMessageCache()
  // Last, so the next launch cannot paint the previous account (SHO-580).
  void clearAuthSessionCache()
  void clearProjectsCache()
}

/**
 * The auth failures that reach here are the ones the shared provider judged
 * worth reporting (`shouldReportAuthError`: no status, or 5xx). A blocked
 * sign-up domain, a wrong password or an existing account is not one of them —
 * they are the API working as designed. Only the provider, stage, status and
 * API code are attached; never a password, token or cookie value (SHO-414,
 * SHO-429).
 */
function reportAuthError(error: unknown, context: AuthErrorContext): void {
  const tags: Record<string, string> = {
    'auth.provider': context.provider,
    'auth.stage': context.stage,
  }
  if (error instanceof AuthRequestError) {
    if (error.status !== undefined) tags['auth.status'] = String(error.status)
    if (error.code) tags['auth.code'] = error.code
  }
  Sentry.captureException(error, { tags })
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    // `shogo:active-workspace-id` is a bare, unscoped-by-user cache key.
    // Without clearing it here, signing out and into a different account
    // on the same browser/device leaves the previous account's workspace
    // id active, and every workspace-scoped fetch for the new account
    // 400/403s with "Access denied to this workspace" until they manually
    // switch workspaces. See `lib/workspace-store.ts`. Cached team chat
    // messages are removed too so they don't outlive the session.
    <SharedAuthProvider
      authClient={authClient}
      onSignOut={onSignOut}
      onAuthError={reportAuthError}
      // Native only: the app paints from the session already on the device and
      // confirms it in the background, so a signed-in launch never waits on a
      // `get-session` round trip (SHO-580). The browser has a cookie jar that
      // answers synchronously, so web keeps the network-gated behaviour it has
      // always had.
      {...(Platform.OS === 'web'
        ? {}
        : { cachedUser: readCachedAuthUser, onUserChanged: rememberAuthUser })}
      // In the browser the auth client resolves `signIn.social` after setting
      // `window.location.href`, so the session it reports is read before the
      // provider is even contacted. On native the Expo plugin awaits the OAuth
      // sheet, so the same read is the round trip's verdict (SHO-430).
      socialSignInNavigatesPage={Platform.OS === 'web'}
    >
      {children}
    </SharedAuthProvider>
  )
}

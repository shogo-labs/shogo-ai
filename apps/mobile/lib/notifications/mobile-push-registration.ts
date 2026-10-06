// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Native push registration is excluded from web and Electron bundles. */
export function hasRegisteredMobilePushSubscription(): boolean {
  return false
}

export function useMobilePushRegistration(_userId: string | null, _agentTurns = true) {
  void _userId
}

/** Web and desktop have no device push token. */
export function subscribePushToken(_listener: (token: string | null) => void): () => void {
  return () => {}
}

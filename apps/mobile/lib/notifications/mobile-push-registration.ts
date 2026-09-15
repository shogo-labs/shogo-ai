// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Native push registration is excluded from web and Electron bundles. */
export function useMobilePushRegistration(_userId: string | null) {
  void _userId
}

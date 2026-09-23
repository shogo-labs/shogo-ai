// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Native app-install reporting is excluded from web and Electron bundles. */
export function useAppInstallHeartbeat(_userId: string | null) {
  void _userId
}

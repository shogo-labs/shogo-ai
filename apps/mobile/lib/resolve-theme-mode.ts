// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type ThemePreference = 'light' | 'dark' | 'system'

/** Maps a stored preference plus the OS scheme to the rendered light/dark mode. */
export function resolveThemeMode(
  preference: ThemePreference,
  systemColorScheme: string | null | undefined,
): 'light' | 'dark' {
  if (preference === 'system') {
    return systemColorScheme === 'dark' ? 'dark' : 'light'
  }
  return preference
}

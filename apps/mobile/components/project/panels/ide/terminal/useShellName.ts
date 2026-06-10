// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live shell-name hook for the terminal header.
 *
 * VS Code's terminal panel shows the active shell binary (zsh, bash) in a
 * dropdown so the user can switch profiles. We need the same.
 *
 * The `sessionId` is accepted so we can later key the override per-session.
 * Today we use a single global preference, which matches VS Code's behavior
 * for "Select Default Profile" (it sets the default for *new* terminals;
 * existing terminals keep their current shell).
 */
import { useState } from 'react'

export type ShellName = 'zsh' | 'bash' | 'cmd' | string

const PROFILE_KEY = 'shogo:terminal:profile'

function defaultShellForPlatform(): ShellName {
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'zsh'
    if (ua.includes('linux')) return 'bash'
    if (ua.includes('windows')) return 'cmd'
  }
  return 'zsh'
}

function readStoredProfile(): ShellName | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const v = window.localStorage.getItem(PROFILE_KEY)
    return v && v.length > 0 ? (v as ShellName) : null
  } catch {
    return null
  }
}

/**
 * Returns the live shell name to display in the terminal header and a setter
 * to override it (used by the profile picker in the chrome).
 *
 * The `sessionId` is accepted so we can later key the override per-session.
 * Today we use a single global preference, which matches VS Code's behavior
 * for "Select Default Profile" (it sets the default for *new* terminals;
 * existing terminals keep their current shell).
 */
export function useShellName(_sessionId: string): {
  shellName: ShellName
  setShellName: (next: ShellName) => void
} {
  const [shellName, setShellNameState] = useState<ShellName>(() => readStoredProfile() ?? defaultShellForPlatform())

  const setShellName = (next: ShellName) => {
    setShellNameState(next)
    try {
      window.localStorage.setItem(PROFILE_KEY, next)
    } catch {
      // localStorage unavailable — keep in-memory state only.
    }
  }

  return { shellName, setShellName }
}

export const SHELL_OPTIONS: ShellName[] = ['zsh', 'bash']

export const SHELL_LABELS: Record<string, string> = {
  zsh: 'zsh',
  bash: 'bash',
}

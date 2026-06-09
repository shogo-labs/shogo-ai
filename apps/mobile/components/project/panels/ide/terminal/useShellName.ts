// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live shell-name hook for the terminal header.
 *
 * VS Code's terminal panel shows the active shell binary (zsh, bash, fish,
 * pwsh) in a dropdown so the user can switch profiles. We need the same.
 *
 * Why a hook (not a static prop):
 *   - In desktop runtime, the user can change profile mid-session via the …
 *     menu → "Select Default Profile". The header must re-render.
 *   - The shell binary the PTY actually spawned isn't tracked in
 *     session-reducer's `Session` shape today. Until we extend the protocol
 *     to surface `process.env.SHELL` from the pty-host back to the renderer,
 *     this hook returns a sensible platform default and exposes a setter
 *     so the … menu can override it locally.
 *
 *   - We intentionally do NOT block this on extending the desktop bridge —
 *     Phase 3 is about chrome. Phase 12+ can wire the real shell-name from
 *     the host once profile-switching is in.
 */
import { useEffect, useState } from 'react'

export type ShellName = 'zsh' | 'bash' | 'fish' | 'pwsh' | 'cmd' | 'sh' | string

const PROFILE_KEY = 'shogo:terminal:profile'

function defaultShellForPlatform(): ShellName {
  // Renderer is always in a browser context; we infer from userAgent.
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'zsh'
    if (ua.includes('linux')) return 'bash'
    if (ua.includes('windows')) return 'pwsh'
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

  // Listen for changes from other components that flip the profile (e.g. the
  // … menu's "Select Default Profile" submenu). We use a custom storage event
  // since localStorage 'storage' only fires cross-tab, not in the same tab.
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<{ shellName: ShellName }>
      if (ce.detail?.shellName) setShellNameState(ce.detail.shellName)
    }
    window.addEventListener('shogo:terminal:profile-changed', handler)
    return () => window.removeEventListener('shogo:terminal:profile-changed', handler)
  }, [])

  const setShellName = (next: ShellName) => {
    setShellNameState(next)
    try {
      window.localStorage.setItem(PROFILE_KEY, next)
    } catch {
      // localStorage unavailable — keep in-memory state only.
    }
    window.dispatchEvent(
      new CustomEvent('shogo:terminal:profile-changed', { detail: { shellName: next } }),
    )
  }

  return { shellName, setShellName }
}

export const SHELL_OPTIONS: ShellName[] = ['zsh', 'bash', 'fish', 'pwsh', 'sh']

export const SHELL_LABELS: Record<string, string> = {
  zsh: 'zsh',
  bash: 'bash',
  fish: 'fish',
  pwsh: 'PowerShell',
  sh: 'sh',
}

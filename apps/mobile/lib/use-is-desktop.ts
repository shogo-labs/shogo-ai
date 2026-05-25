// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useIsDesktop — true when running inside the Shogo Desktop (Electron) shell.
 *
 * Detection matches the existing pattern in lib/platform-config.ts:
 *   (window as any).shogoDesktop?.isDesktop
 *
 * Used to hide surfaces that don't make sense on desktop — primarily the
 * Remote Control / instance-pairing UI, since the desktop app IS the local
 * execution environment and pairing it to itself is redundant. Mobile and
 * Web are unaffected and continue to use Remote Control as before.
 */
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'

function detectIsDesktop(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.isDesktop
}

export function isDesktopApp(): boolean {
  return detectIsDesktop()
}

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(detectIsDesktop)
  useEffect(() => {
    setIsDesktop(detectIsDesktop())
  }, [])
  return isDesktop
}

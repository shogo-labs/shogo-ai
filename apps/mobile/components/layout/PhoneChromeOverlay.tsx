// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Full-bleed phone screens draw the bottom dock over their content instead of
 * below it. The shell measures the dock and shares its height so the screen
 * can lift its composer above the dock and pad its list to match.
 */
import { createContext, useContext } from 'react'

export interface PhoneChromeOverlay {
  /** True when the dock floats over the screen content. */
  overlay: boolean
  /** Height of the floating dock, including the bottom safe area. */
  bottom: number
}

export const PhoneChromeOverlayContext = createContext<PhoneChromeOverlay>({ overlay: false, bottom: 0 })

export function usePhoneChromeOverlay(): PhoneChromeOverlay {
  return useContext(PhoneChromeOverlayContext)
}

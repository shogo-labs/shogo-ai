// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ShogoModeToggle — native stub.
 *
 * Shogo Mode is web-only in V1; native builds render nothing. Expo's
 * platform-extension resolution picks `ShogoModeToggle.web.tsx` on
 * web so we can keep DOM-specific effects out of native bundles.
 */

export interface ShogoModeToggleProps {
  className?: string
}

export function ShogoModeToggle(_: ShogoModeToggleProps): null {
  return null
}

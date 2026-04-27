// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ShogoChatPanel — native stub.
 *
 * Shogo Mode is web-only in V1 (it uses `@elevenlabs/react` for the
 * convai session, which depends on browser APIs). Expo's platform-
 * extension resolution picks `ShogoChatPanel.web.tsx` on web; native
 * builds get this no-op module instead, so neither `@elevenlabs/react`
 * nor DOM APIs are ever imported on iOS / Android.
 */

export interface ShogoChatPanelProps {
  /** Optional extra classes for the outer container. */
  className?: string
}

export function ShogoChatPanel(_: ShogoChatPanelProps): null {
  return null
}

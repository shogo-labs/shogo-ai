// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * EzModeChatPanel — native stub.
 *
 * EZ Mode is web-only in V1 (it uses `@elevenlabs/react` for the
 * convai session, which depends on browser APIs). Expo's platform-
 * extension resolution picks `EzModeChatPanel.web.tsx` on web; native
 * builds get this no-op module instead, so neither `@elevenlabs/react`
 * nor DOM APIs are ever imported on iOS / Android.
 */

export interface EzModeChatPanelProps {
  /** Optional extra classes for the outer container. */
  className?: string
}

export function EzModeChatPanel(_: EzModeChatPanelProps): null {
  return null
}

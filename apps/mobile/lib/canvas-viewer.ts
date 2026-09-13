// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat-body `viewer` payload so the project agent knows whether the live
 * canvas preview is a phone or desktop. Shape matches agent-runtime
 * `parseCanvasViewer`.
 */

import type { CanvasViewerFormFactor } from "@shogo-ai/sdk/agent"

export type { CanvasViewerFormFactor } from "@shogo-ai/sdk/agent"

export function canvasViewerPayload(input: {
  isPhoneViewport: boolean
  platform: string
  width: number
}): { formFactor: CanvasViewerFormFactor; platform: string; width: number } {
  const width = Number.isFinite(input.width) ? Math.max(1, Math.round(input.width)) : 1
  return {
    formFactor: input.isPhoneViewport ? "phone" : "desktop",
    platform: input.platform,
    width,
  }
}

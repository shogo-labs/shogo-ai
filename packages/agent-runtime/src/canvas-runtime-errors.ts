// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas Runtime Errors — shared ring buffer for compile/runtime errors
 * reported by the canvas WebView. Consumed by the read_lints tool so the
 * agent can see errors from the rendered canvas alongside LSP diagnostics.
 */

export interface CanvasRuntimeError {
  surfaceId: string
  phase: string
  error: string
  timestamp: number
}

const MAX_CANVAS_ERRORS = 20
const canvasRuntimeErrors: CanvasRuntimeError[] = []

export function pushCanvasRuntimeError(entry: CanvasRuntimeError): void {
  canvasRuntimeErrors.push(entry)
  if (canvasRuntimeErrors.length > MAX_CANVAS_ERRORS) {
    canvasRuntimeErrors.splice(0, canvasRuntimeErrors.length - MAX_CANVAS_ERRORS)
  }
}

export function getCanvasRuntimeErrors(): CanvasRuntimeError[] {
  return canvasRuntimeErrors
}

export function clearCanvasRuntimeErrors(): void {
  canvasRuntimeErrors.length = 0
}

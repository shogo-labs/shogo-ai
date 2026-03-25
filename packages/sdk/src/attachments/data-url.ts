// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Build a `data:` URL from a MIME type and raw base64 payload (no `data:` prefix).
 * Used by clients (e.g. Expo) after reading a file as base64 via native APIs.
 */
export function buildDataUrlFromBase64(mimeType: string, base64: string): string {
  const mime = mimeType.trim() || 'application/octet-stream'
  return `data:${mime};base64,${base64}`
}

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects whether an error represents a context/token-length overflow from
 * any of the supported LLM providers.
 *
 * Kept as a standalone module (no external imports) so it can be unit-tested
 * without a full workspace install.
 */

export function isContextOverflowError(err: any): boolean {
  if (!err) return false
  const status = err.status ?? err.statusCode ?? err.code
  if (status === 413) return true
  const msg = String(err.message || err).toLowerCase()
  return (
    msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed'))
  ) || msg.includes('prompt is too long')
    || msg.includes('maximum context length')
    || msg.includes('request too large')
    || msg.includes('input is too long')
    || msg.includes('too many tokens')
    || msg.includes('reduce your prompt')
    || msg.includes('string too long')
}

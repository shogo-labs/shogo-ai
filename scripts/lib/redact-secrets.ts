// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Token-shaped secret redaction, shared by everything that writes a transcript
 * to disk (mined fixtures, compaction fixtures).
 *
 * Extracted from `mine-prod-failures.ts` so there is one pattern list: a new
 * key format added in one script must not be missing in the other.
 */

export const SECRET_PATTERNS: RegExp[] = [
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
]

/** Replace every token-shaped secret in `text`. */
export function redactSecretText(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted-secret]')
  return out
}

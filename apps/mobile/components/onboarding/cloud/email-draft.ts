// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `Alice Smith <alice@x.com>` -> `alice@x.com`, so pasted address-book entries don't leave the display name behind. */
const DISPLAY_NAME_ADDRESS_RE = /[^<>,;]*<([^<>,;]+)>/g

function cleanToken(token: string): string {
  return token
    .replace(/^["'<(]+/, '')
    .replace(/[.,;:]+$/, '')
    .replace(/["'>)]+$/, '')
    .replace(/[.,;:]+$/, '')
}

/** Split free-typed input into valid addresses and leftover invalid tokens. */
export function parseEmailDraft(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .replace(DISPLAY_NAME_ADDRESS_RE, ' $1 ')
    .split(/[,;\s]+/)
    .map((p) => cleanToken(p.trim().toLowerCase()))
    .filter(Boolean)
  return {
    valid: parts.filter((p) => EMAIL_RE.test(p)),
    invalid: parts.filter((p) => !EMAIL_RE.test(p)),
  }
}

// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Split free-typed input into valid addresses and leftover invalid tokens. */
export function parseEmailDraft(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw.split(/[,;\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean)
  return {
    valid: parts.filter((p) => EMAIL_RE.test(p)),
    invalid: parts.filter((p) => !EMAIL_RE.test(p)),
  }
}

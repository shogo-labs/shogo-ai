// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Best-effort cosmetic formatting of a synthetic-shell `cwd` for the
 * inline prompt. Purely cosmetic — used to decide whether to render the
 * prompt as `~/foo` (inside project) or `/abs/path` (user `cd`'d
 * elsewhere). NOT a security boundary; the server enforces escape
 * restrictions independently.
 *
 * Behavior:
 *   - null / empty                → ""
 *   - "/"                         → "/"
 *   - "/tmp"                      → "/tmp"  (single segment kept absolute)
 *   - "/a/b/c/d"                  → "c/d"   (last two segments)
 */
export function formatPromptCwd(cwd: string | null): string {
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  if (parts.length === 1) return '/' + parts[0]
  return parts.slice(-2).join('/')
}

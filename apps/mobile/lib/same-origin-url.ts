// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * True when `uri` lives on `base`'s origin. String-based on purpose: React
 * Native's `URL` does not implement `origin`. The character after the base
 * must be `/`, `?` or `#`, so `https://api.x.com@evil.com/` and
 * `https://api.x.com.evil.com/` do not match `https://api.x.com`.
 */
export function isUrlOnOrigin(uri: string, base: string | null | undefined): boolean {
  if (!base) return false
  const origin = base.replace(/\/+$/, "").toLowerCase()
  if (!origin) return false
  const candidate = uri.toLowerCase()
  if (!candidate.startsWith(origin)) return false
  const next = candidate.charAt(origin.length)
  return next === "" || next === "/" || next === "?" || next === "#"
}

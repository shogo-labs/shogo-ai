// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// Imported from api-url rather than api on purpose: this resolver is used by
// ~10 widely-rendered components (message authors, member lists, the account
// menu), and `api` carries the whole client graph including the auth client.
// Pulling that into every avatar render site is both slower and a test hazard.
import { API_URL } from './api-url'

export function resolveChatAttachmentUrl(url: string): string {
  if (!url || /^(?:data:|blob:|https?:\/\/)/i.test(url)) return url
  if (!url.startsWith('/') || !API_URL) return url
  return `${API_URL.replace(/\/+$/, '')}${url}`
}

/**
 * A stored `User.image` as something an `<Image>` can actually load.
 *
 * The column holds two different shapes: the relative `/api/user-avatar/...`
 * URL we write for an uploaded picture, and the absolute provider URL OAuth
 * writes (Google/Apple `picture`). The resolver above already passes absolute,
 * `data:` and `blob:` values through untouched, so this adds only the null
 * handling the render sites need.
 */
export function resolveAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return resolveChatAttachmentUrl(url)
}

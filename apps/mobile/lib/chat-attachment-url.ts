// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { API_URL } from './api'

export function resolveChatAttachmentUrl(url: string): string {
  if (!url || /^(?:data:|blob:|https?:\/\/)/i.test(url)) return url
  if (!url.startsWith('/') || !API_URL) return url
  return `${API_URL.replace(/\/+$/, '')}${url}`
}

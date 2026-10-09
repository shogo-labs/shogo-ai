// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHash } from 'node:crypto'

/**
 * Deterministic UUID for the project chat that records one runId's calls into
 * a project. Keeping this in shared-runtime lets the caller UI know the chat
 * id before the project agent finishes.
 */
export function runChatSessionId(projectId: string, runId: string): string {
  const hash = createHash('sha1').update(`shogo:project-call:${projectId}:${runId}`).digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

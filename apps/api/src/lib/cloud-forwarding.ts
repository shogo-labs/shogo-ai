// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A desktop that is signed in to Shogo Cloud (`SHOGO_API_KEY` on a bundled
 * instance). Says nothing about which provider answers LLM calls — see
 * `isShogoCloudForwarding()` for that question.
 */
export function isShogoCloudAuthed(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true' && !!process.env.SHOGO_API_KEY
}

/**
 * Desktop relays every LLM call to the Shogo Cloud AI proxy when it has a
 * linked cloud key (`SHOGO_API_KEY`) and `AI_MODE` was not switched to the
 * user's own keys or a local model. Cloud then bills the linked cloud
 * workspace, and the local AI proxy records nothing.
 */
export function isShogoCloudForwarding(): boolean {
  if (!isShogoCloudAuthed()) return false
  const aiMode = process.env.AI_MODE
  if (aiMode === 'api-keys' || aiMode === 'local-llm') return false
  return true
}

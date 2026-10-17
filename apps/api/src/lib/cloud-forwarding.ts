// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Desktop relays every LLM call to the Shogo Cloud AI proxy when it has a
 * linked cloud key (`SHOGO_API_KEY`) and `AI_MODE` was not switched to the
 * user's own keys or a local model. Cloud then bills the linked cloud
 * workspace, and the local AI proxy records nothing.
 */
export function isShogoCloudForwarding(): boolean {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || !process.env.SHOGO_API_KEY) return false
  const aiMode = process.env.AI_MODE
  if (aiMode === 'api-keys' || aiMode === 'local-llm') return false
  return true
}

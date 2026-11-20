// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generic channel-secret lifecycle shared by webchat (widgetSecret) and
 * webhook (secret).
 *
 * Both connect paths (the `channel_connect` tool and the Studio panel's
 * `POST /agent/channels/connect`) and the gateway start-up backfill go
 * through this module so the rule lives in one place (follows SHO-380's
 * pattern for webchat, extended in SHO-462 to cover webhook).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'

/**
 * Resolve a channel secret for a connect operation.
 *
 * Precedence: an explicit value in the incoming config, then the value already
 * saved in `config.json`, then a freshly generated one. Keeping the saved
 * value is what makes a reconnect non-destructive.
 */
export function resolveChannelSecret(
  incoming: Record<string, string> | undefined | null,
  saved: Record<string, string> | undefined | null,
  configKey: string,
  generate: () => string,
): string {
  return incoming?.[configKey] || saved?.[configKey] || generate()
}

/**
 * Backfill a secret for an already-connected channel that has none, persisting
 * it to `config.json`.
 *
 * Returns the secret (existing or newly generated), or `null` when the file
 * has no matching channel or cannot be read/written.
 */
export function backfillChannelSecret(
  configPath: string,
  channelType: string,
  configKey: string,
  generate: () => string,
): string | null {
  if (!existsSync(configPath)) return null

  let parsed: any
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }

  const channels = Array.isArray(parsed?.channels) ? parsed.channels : []
  const entry = channels.find((ch: any) => ch?.type === channelType)
  if (!entry) return null

  if (!entry.config || typeof entry.config !== 'object') entry.config = {}
  if (entry.config[configKey]) return entry.config[configKey] as string

  entry.config[configKey] = generate()
  try {
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8')
  } catch {
    return null
  }
  return entry.config[configKey] as string
}

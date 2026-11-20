// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WebChat widget-key lifecycle.
 *
 * The widget key is the only credential an embedded page carries, so it must
 * be created once and then stay stable: rotating it on reconnect breaks every
 * page already embedding the widget. Both connect paths (the `channel_connect`
 * tool and the Studio panel's `POST /agent/channels/connect`) and the gateway's
 * start-up backfill go through this module so the rule lives in one place
 * (SHO-380).
 */

import { randomUUID } from 'crypto'
import { resolveChannelSecret, backfillChannelSecret } from './channel-secret'

/**
 * Resolve the widget key for a webchat connect.
 *
 * Precedence: an explicit key in the incoming config, then the key already
 * saved in `config.json`, then a freshly generated one. Keeping the saved key
 * is what makes a reconnect non-destructive.
 */
export function resolveWebchatWidgetSecret(
  incoming: Record<string, string> | undefined | null,
  saved: Record<string, string> | undefined | null,
): string {
  return resolveChannelSecret(incoming, saved, 'widgetSecret', randomUUID)
}

/**
 * Backfill a widget key for an already-connected webchat channel that has
 * none, persisting it to `config.json`.
 *
 * Channels connected from the Studio panel before SHO-380 never got a key, so
 * their embeds 403 on `/config` and `/session`. Running this at gateway start
 * makes those channels work without the owner reconnecting. Returns the key
 * (existing or newly generated), or `null` when the file has no webchat
 * channel or cannot be read/written.
 */
export function backfillWebchatWidgetSecret(configPath: string): string | null {
  return backfillChannelSecret(configPath, 'webchat', 'widgetSecret', randomUUID)
}

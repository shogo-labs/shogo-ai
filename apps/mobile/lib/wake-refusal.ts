// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a refused wake action says, in the server's own words (`409 not_pending`,
 * `403` for a viewer).
 *
 * Both views of the queue show it — the thread's note (`QueuedWakeRow`) and the
 * session's dock (`QueueDockPanel`) — so it lives on its own, free of the HTTP
 * client, and neither view drags the team-chat API in to render a message.
 */
export function wakeRefusalMessage(error: unknown, fallback = 'That message is not waiting any more'): string {
  const fromBody = (error as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody
  return error instanceof Error && error.message ? error.message : fallback
}

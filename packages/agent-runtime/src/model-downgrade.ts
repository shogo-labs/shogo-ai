// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model-downgrade notice (SHO-417).
 *
 * When a tagged agent is configured with a model the person behind the turn
 * cannot use, the API moves that run to the person's default model and stamps
 * `modelDowngrade: { from, to }` on the chat body. The runtime states it in the
 * reply's first line, in code, before the model writes anything — asking the
 * model to mention it would make the notice optional.
 */

export interface ModelDowngrade {
  from: string
  to: string
}

/** Read `modelDowngrade` off a chat body. Malformed input is ignored. */
export function parseModelDowngrade(raw: unknown): ModelDowngrade | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { from?: unknown; to?: unknown }
  if (typeof value.from !== 'string' || !value.from) return null
  if (typeof value.to !== 'string' || !value.to) return null
  return { from: value.from, to: value.to }
}

/** The first line of the reply when a run was moved off its configured model. */
export function modelDowngradeNotice(downgrade: ModelDowngrade): string {
  return `Ran on ${downgrade.to} because your role can't use ${downgrade.from}.\n\n`
}

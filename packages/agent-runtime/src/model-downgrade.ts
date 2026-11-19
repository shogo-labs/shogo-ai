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
  /** Display names, when the API could resolve them. The notice prefers these. */
  fromLabel?: string
  toLabel?: string
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Read `modelDowngrade` off a chat body. Malformed input is ignored. */
export function parseModelDowngrade(raw: unknown): ModelDowngrade | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { from?: unknown; to?: unknown; fromLabel?: unknown; toLabel?: unknown }
  const from = nonEmptyString(value.from)
  const to = nonEmptyString(value.to)
  if (!from || !to) return null
  const fromLabel = nonEmptyString(value.fromLabel)
  const toLabel = nonEmptyString(value.toLabel)
  return {
    from,
    to,
    ...(fromLabel ? { fromLabel } : {}),
    ...(toLabel ? { toLabel } : {}),
  }
}

/** The first line of the reply when a run was moved off its configured model. */
export function modelDowngradeNotice(downgrade: ModelDowngrade): string {
  const from = downgrade.fromLabel ?? downgrade.from
  const to = downgrade.toLabel ?? downgrade.to
  return `Ran on ${to} because your role can't use ${from}.\n\n`
}

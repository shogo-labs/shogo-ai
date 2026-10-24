// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tells an agent that its session is holding background updates it has not
 * been given yet.
 *
 * A session that auto-wakes several turns in a row without a person writing
 * in between is paused: the updates stay queued and the session waits. Without
 * this block a resumed session re-derives work it cannot see, re-asks for it,
 * or starts over. It goes after the cache boundary (it changes per turn) and
 * only while a pause is actually in place — a session that is running normally
 * gets no block at all.
 */

import type { SessionWakeState } from './internal-api'

export function buildWakeStatusSection(state: SessionWakeState | null | undefined): string | null {
  if (!state?.paused) return null
  const titles = state.waiting.map((task) => `- ${task.title}`).join('\n')
  const count = state.waiting.length
  const noun = count === 1 ? 'update is' : 'updates are'
  return [
    '## Background Updates Waiting',
    '',
    `${count || 'Some'} background task ${noun} waiting for this session — they were paused after ${state.wakesInARow} wake turns in a row (limit ${state.limit}) and are delivered when a person next writes.`,
    ...(titles ? ['', titles] : []),
    '',
    'Do not re-ask for these and do not restart the work they belong to: they are already queued. Finish what you have and say what you are waiting on.',
  ].join('\n')
}

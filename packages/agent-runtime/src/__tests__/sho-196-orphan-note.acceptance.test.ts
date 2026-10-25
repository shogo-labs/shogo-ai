// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-196 acceptance (QA): a completion note must never outlive the entry that
 * proves who owns it.
 *
 * The 15-copy loop came from a note that survived `forget()`: with the entry
 * gone, every ownership guard read `undefined` and failed open, so the note was
 * handed to the API as a local task and came back as a wake. These assertions
 * cover the two halves the delivery path relies on and that the dev's tests do
 * not reach: a note already *reported* to the API (not just an `apiTracked`
 * one), and the queue actually being empty afterwards — `flushTaskWake` has
 * nothing to POST only if no orphan is left pending.
 */

import { describe, test, expect } from 'bun:test'
import { TaskRegistry, type RemoteTaskClient } from '../task-registry'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function unreadFinished(reg: TaskRegistry, title = 'explore') {
  const task = reg.registerTask({ source: 'subagent', title, backgrounded: true, notify: true })
  task.finish('completed', { summary: `${title}: the report` })
  return task
}

function cardClient(output: string): RemoteTaskClient {
  return {
    async get(id) { return { id, status: 'completed', output } },
    async cancel() {},
    async consume() {},
  }
}

describe('SHO-196 · an orphan note is never handed over as a local task', () => {
  test('a note the turn already handed to the API does not outlive its evicted entry', async () => {
    const reg = new TaskRegistry({ maxUnconsumed: 1, unreadRetentionMs: 60_000 })
    const first = unreadFinished(reg, 'explore')

    // What `flushTaskWake` does after `/tasks/notify` accepts the note.
    reg.markReported([first.entry.id])
    expect(reg.peekNotifications().find((n) => n.taskId === first.entry.id)?.reported).toBe(true)

    await sleep(2)
    unreadFinished(reg, 'second')

    // The API owns delivery now, so eviction has to take the note with it —
    // otherwise the next turn end re-POSTs a result the API already delivered.
    expect(reg.get(first.entry.id)).toBeUndefined()
    expect(reg.peekNotifications().map((n) => n.taskId)).not.toContain(first.entry.id)
  })

  test('an API-tracked card leaves nothing pending when its entry is evicted', async () => {
    const reg = new TaskRegistry({ maxUnconsumed: 1, unreadRetentionMs: 60_000 })
    for (const id of ['t_card196a', 't_card196b']) {
      reg.registerRemote({
        id,
        source: 'work_item',
        title: 'SUP-196',
        apiTracked: true,
        client: cardClient('moved to QA & Review (active)'),
      })
      await reg.refreshRemote()
      await sleep(2)
    }

    // Only the surviving card still owes a note; the evicted one owes nothing.
    expect(reg.get('t_card196a')).toBeUndefined()
    expect(reg.peekNotifications().map((n) => n.taskId)).toEqual(['t_card196b'])

    // Acking the survivor empties the queue: no orphan is left for a wake.
    reg.markConsumed(['t_card196b'])
    expect(reg.hasPendingNotifications()).toBe(false)
  })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A `sleep` used to check on a background task cannot see the finish early and
 * always spends the whole delay. `wait` returns the instant it settles, so the
 * runtime steers a sleep poll to it (exec-detach.ts refuses `&` for the same
 * reason). Detection must not fire on a project's own test/retry scripts.
 */

import { describe, test, expect } from 'bun:test'
import { checkSleepPoll } from '../exec-poll'

describe('checkSleepPoll', () => {
  test('a bare sleep is a poll', () => {
    expect(checkSleepPoll('sleep 30').poll).toBe(true)
    expect(checkSleepPoll('sleep 0.5').poll).toBe(true)
  })

  test('a sleep in front of a probe is a poll', () => {
    expect(checkSleepPoll('sleep 30 && cat .shogo/tasks/s/t_1.log').poll).toBe(true)
    expect(checkSleepPoll('sleep 10; task_list').poll).toBe(true)
    expect(checkSleepPoll('task_list && sleep 10 && task_list').poll).toBe(true)
  })

  test('a bounded while/sleep loop is a poll', () => {
    expect(checkSleepPoll('while true; do task_list; sleep 5; done').poll).toBe(true)
    expect(checkSleepPoll('for i in 1 2 3; do sleep 2; cat out.log; done').poll).toBe(true)
  })

  test('a project script, a test run or a build is not a poll', () => {
    expect(checkSleepPoll('bun test').poll).toBe(false)
    expect(checkSleepPoll('bun run typecheck').poll).toBe(false)
    expect(checkSleepPoll('./scripts/run.sh').poll).toBe(false)
    expect(checkSleepPoll('rg -n "sleep" src').poll).toBe(false)
    expect(checkSleepPoll('git status').poll).toBe(false)
  })

  test('a sleep that belongs to a backgrounded job is not the agent waiting', () => {
    expect(checkSleepPoll('bun run dev & sleep 5 && curl localhost:3000').poll).toBe(true)
    expect(checkSleepPoll('nohup sleep 30 > /dev/null 2>&1 &').poll).toBe(false)
  })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The background-task graders on scripted trajectories: every reasonable
 * route to the outcome earns full marks and each anti-pattern loses its
 * points.
 */

import { describe, expect, test } from 'bun:test'
import { BACKGROUND_TASK_EVALS } from './test-cases-background-tasks'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'

function evalById(id: string): AgentEval {
  const found = BACKGROUND_TASK_EVALS.find((e) => e.id === id)
  if (!found) throw new Error(`no eval ${id}`)
  return found
}

function result(
  toolCalls: Array<Partial<ToolCallRecord> & { name: string }>,
  responseText: string,
  durationMs = 20_000,
): EvalResult {
  const calls = toolCalls.map((t) => ({ input: {}, output: '', ...t })) as ToolCallRecord[]
  return { toolCalls: calls, finalTurnToolCalls: calls, responseText, timing: { durationMs } } as unknown as EvalResult
}

function failing(ev: AgentEval, r: EvalResult): string[] {
  return ev.validationCriteria.filter((c) => !c.validate(r)).map((c) => c.id)
}

const running = (taskId: string, extra = '') =>
  JSON.stringify({ status: 'running', task_id: taskId, output_file: `.shogo/tasks/s/${taskId}.log`, stdout: extra })

describe('background task graders', () => {
  test('every case has points that add up to its max score', () => {
    for (const ev of BACKGROUND_TASK_EVALS) {
      expect(ev.validationCriteria.reduce((n, c) => n + c.points, 0)).toBe(ev.maxScore)
    }
  })

  test('prompts never name the task tools or tell the agent how to wait', () => {
    for (const ev of BACKGROUND_TASK_EVALS) {
      if (ev.input.startsWith('[Task update]')) continue
      expect(ev.input).not.toMatch(/\b(wait|background|task_id|poll|seconds|minutes|block)\b/i)
    }
  })

  test('test suite: blocking, or backgrounding and waiting, both pass; re-running and sleeping fail', () => {
    const ev = evalById('bg-test-suite')
    const blocking = result([
      { name: 'read_file', input: { path: 'package.json' } },
      { name: 'exec', input: { command: 'bun run test', timeout: 120_000 }, output: 'Tests: 42 passed, 0 failed' },
    ], '42 tests pass.')
    expect(failing(ev, blocking)).toEqual([])

    const softTimeout = result([
      { name: 'exec', input: { command: 'npm test' }, output: running('t_aaaa1111') },
      { name: 'wait', input: { task_ids: ['t_aaaa1111'], timeout_ms: 60_000 } },
    ], 'All 42 tests passed.')
    expect(failing(ev, softTimeout)).toEqual([])

    const compound = result([
      { name: 'exec', input: { command: 'ls test; cat package.json; bun test 2>&1 | tail -5', timeout: 120_000 }, output: '42 pass' },
    ], '42 pass, 0 fail.')
    expect(failing(ev, compound)).toEqual([])

    const bad = result([
      { name: 'exec', input: { command: 'cat package.json' } },
      { name: 'exec', input: { command: 'bun run test' }, output: running('t_aaaa1111') },
      { name: 'exec', input: { command: 'sleep 20' } },
      { name: 'exec', input: { command: 'sleep 20' } },
      { name: 'exec', input: { command: 'bun run test' } },
    ], 'Something passed.')
    expect(failing(ev, bad)).toEqual(['ran-once', 'no-polling', 'reported-result'])
  })

  test('dev server: any route that reports the printed port passes; killing it fails', () => {
    const ev = evalById('bg-dev-server')
    const start = { name: 'exec', input: { command: 'bun run dev', background: true }, output: running('t_dev00001') }
    const ready = { name: 'wait', input: { task_ids: ['t_dev00001'], until: 'ready on' }, output: JSON.stringify({ output: 'Port 4321 is in use, trying another one...\n  ➜  Local:   http://localhost:51234/' }) }
    expect(failing(ev, result([start, ready], 'The app is running at http://localhost:51234.'))).toEqual([])

    const bareUntil = { name: 'wait', input: { until: 'ready on' }, output: JSON.stringify({ output: '  ➜  Local:   http://localhost:51234/' }) }
    expect(failing(ev, result([start, bareUntil], 'Open http://localhost:51234'))).toEqual([])

    expect(failing(ev, result([start, { name: 'task_cancel', input: { task_id: 't_dev00001' } }], 'It is on port 3000.')))
      .toEqual(['left-running', 'reported-url'])
  })

  test('quick command: a plain exec passes; backgrounding and waiting fail', () => {
    const ev = evalById('bg-quick-command')
    expect(failing(ev, result([{ name: 'exec', input: { command: 'bun run lint' }, output: 'Linted 38 files: 0 problems' }], 'Lint is clean: 0 problems.'))).toEqual([])
    expect(failing(ev, result([
      { name: 'exec', input: { command: 'bun run lint', background: true }, output: running('t_lint0001') },
      { name: 'wait', input: { task_ids: ['t_lint0001'] } },
    ], 'No problems found.'))).toEqual(['no-task-machinery'])
  })

  test('fire and forget: starting and ending the turn passes; waiting it out fails', () => {
    const ev = evalById('bg-fire-and-forget')
    const start = { name: 'exec', input: { command: 'bun run export', background: true }, output: running('t_exp00001') }
    expect(failing(ev, result([start], 'The export is running; its log is at .shogo/tasks/s/t_exp00001.log.', 8_000))).toEqual([])
    expect(failing(ev, result([start, { name: 'wait', input: { task_ids: ['t_exp00001'], timeout_ms: 120_000 } }], 'Done.', 95_000)))
      .toEqual(['did-not-block'])
  })

  test('delegated research: agents collected with wait pass; polling and wrong findings fail', () => {
    const ev = evalById('bg-delegated-research')
    const spawn = (area: string) => ({ name: 'agent_spawn', input: { type: 'explore', prompt: `retries in services/${area}`, background: true } })
    const good = result([
      spawn('billing'), spawn('auth'), spawn('search'),
      { name: 'wait', input: { task_ids: ['t_1', 't_2', 't_3'], timeout_ms: 120_000 } },
      { name: 'read_file', input: { path: 'services/search/client.ts' }, viaSubagent: true },
    ], 'Billing retries 7 times with exponential backoff, auth retries 4 times with a fixed 250ms delay, and search has no retries.')
    expect(failing(ev, good)).toEqual([])

    const bad = result([
      spawn('billing'), spawn('auth'),
      { name: 'task_list' }, { name: 'task_list' }, { name: 'task_list' },
    ], 'Billing retries a few times.')
    expect(failing(ev, bad)).toEqual(['no-polling', 'correct-findings'])
  })

  test('project call meanwhile: async call then README fix passes; blocking and re-sending fails', () => {
    const ev = evalById('bg-project-call-meanwhile')
    const asyncCall = { name: 'project_call', input: { project: 'Analyst', message: 'Q3 churn report', wait: false } }
    const fix = { name: 'edit_file', input: { path: 'README.md', old_string: 'Welcom to', new_string: 'Welcome to' } }
    const report = { name: 'wait', input: { task_ids: ['t_pc00q3ch'] } }
    expect(failing(ev, result([asyncCall, fix, report], 'README fixed. Q3 churn was 4.2%.'))).toEqual([])
    expect(failing(ev, result([asyncCall, fix], 'Fixed the README; the Analyst is still working on the report.'))).toEqual([])

    const blocking = { name: 'project_call', input: { project: 'Analyst', message: 'Q3 churn report' } }
    expect(failing(ev, result([blocking, asyncCall, report, fix], 'Q3 churn was 4.2% and the README is fixed.')))
      .toEqual(['asked-once', 'did-not-block', 'fixed-readme'])
  })

  test('ask teammate: acting on the reply passes; polling the thread and guessing fails', () => {
    const ev = evalById('bg-ask-teammate')
    const post = { name: 'team_chat_post', input: { channel: 'design', text: '@Designer which color for the primary button?' } }
    const write = { name: 'write_file', input: { path: 'theme.json', content: '{"primaryColor": "#3B82F6"}' } }
    expect(failing(ev, result([post, { name: 'wait', input: { task_ids: ['t_rep0dsgn'] } }, write], 'Done.'))).toEqual([])

    const read = { name: 'team_chat_read', input: { channel: 'design' } }
    const guess = { name: 'write_file', input: { path: 'theme.json', content: '{"primaryColor": "#000000"}' } }
    expect(failing(ev, result([post, read, read, read, guess], 'No reply yet, so I used black.'))).toEqual(['no-thread-polling', 'wrote-color'])
  })

  test('card watch: watching and ending the turn passes; posting early or waiting in a loop fails', () => {
    const ev = evalById('bg-card-watch')
    const get = { name: 'work_item_get', input: { item: 'SUP-12' } }
    const wait = { name: 'wait', input: { task_ids: ['t_card0s12'], until: 'Done' } }
    expect(failing(ev, result([get, wait], 'SUP-12 is still In Progress. I will post in #releases once it is done.'))).toEqual([])

    const post = { name: 'team_chat_post', input: { channel: 'releases', text: 'Login fix shipped' } }
    expect(failing(ev, result([get, post], 'Posted.'))).toEqual(['watched-card', 'did-not-post-early', 'told-user'])
    expect(failing(ev, result([get, wait, wait, wait, get, get], 'Still waiting on SUP-12.'))).toEqual(['ended-turn'])
  })

  test('card wake: posting from the update passes; waiting again fails', () => {
    const ev = evalById('bg-card-wake')
    const post = { name: 'team_chat_post', input: { channel: 'releases', text: 'Login fix shipped' } }
    expect(failing(ev, result([post], 'Posted in #releases.'))).toEqual([])
    expect(failing(ev, result([{ name: 'wait', input: { task_ids: ['t_card0s12'] } }], 'Waiting.'))).toEqual(['posted', 'no-more-waiting'])
  })

  test('test wake: reporting from the update passes; re-running the suite fails', () => {
    const ev = evalById('bg-test-wake')
    const ownSearch = [
      { name: 'exec', input: { command: 'find . -name "totals.test.ts"' }, output: running('t_find0001') },
      { name: 'wait', input: { task_ids: ['t_find0001'] } },
    ]
    expect(failing(ev, result(ownSearch, 'totals > rounds to cents failed: expected 10.01, got 10.005.'))).toEqual([])
    expect(failing(ev, result([{ name: 'read_file', input: { path: '.shogo/tasks/eval/t_shell001.log' } }], 'One failure: totals > rounds to cents (got 10.005).'))).toEqual([])
    expect(failing(ev, result([{ name: 'exec', input: { command: 'bun test' } }, { name: 'wait', input: { task_ids: ['t_shell001'] } }], 'Re-ran the totals tests.')))
      .toEqual(['did-not-rerun-suite', 'reported-failure', 'no-waiting'])
  })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Background Task Evals
 *
 * Every prompt is phrased the way a user would ask, without naming tools,
 * flags, durations or how to wait. The agent has to notice on its own that
 * the work is slow, keeps running, or depends on someone else, and pick
 * between blocking on it, ending the turn, or not backgrounding at all.
 *
 * Graders score outcomes (the right answer, the work done once, nothing
 * killed, no polling) and accept any reasonable route to them. Mocks for
 * API-backed sources answer `wait` only for the task id they handed out and
 * use the same shapes as production, including timeouts.
 *
 * Track: --track background-tasks
 */

import type { AgentEval, EvalResult, ToolCallRecord } from './types'
import type { ToolMockMap, ToolMockSpec } from './tool-mocks'
import { responseContains } from './eval-helpers'

const HINT = 'Call wait({ task_ids: [task_id] }) to block on it, or end your turn and you will get a [Task update] when it finishes.'
const STILL_RUNNING_HINT = 'Still running. Wait again, or end your turn and you will get a [Task update] when it finishes.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Calls the main agent made itself (subagent calls are recorded too). */
function mainCalls(r: EvalResult, name?: string): ToolCallRecord[] {
  return r.toolCalls.filter((t) => !t.viaSubagent && (!name || t.name === name))
}

const commandOf = (t: ToolCallRecord): string => String((t.input as { command?: unknown })?.command ?? '')
const outputText = (t: ToolCallRecord): string => (typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? ''))

/** Reading a file is not running it. */
const READ_ONLY = /^\s*(cat|head|tail|less|more|grep|rg|ls|wc|file|stat|sed\s+-n)\b/

/** exec calls with a step (between `;`, `&&`, `||`, `|` or newlines) that ran a command matching `pattern`. */
function invocations(r: EvalResult, pattern: RegExp): ToolCallRecord[] {
  return mainCalls(r, 'exec').filter((t) =>
    commandOf(t).split(/;|&&|\|\||\||\n/).some((step) => pattern.test(step) && !READ_ONLY.test(step)))
}

/** Task ids handed back by the given tool calls. */
function taskIdsOf(calls: ToolCallRecord[]): string[] {
  return calls.flatMap((t) => [...outputText(t).matchAll(/"task_id"\s*:\s*"(t_[A-Za-z0-9]+)"/g)].map((m) => m[1]!))
}

function waitIds(t: ToolCallRecord): string[] {
  const ids = (t.input as { task_ids?: unknown })?.task_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

function waitsOn(r: EvalResult, taskId: string): ToolCallRecord[] {
  return mainCalls(r, 'wait').filter((t) => waitIds(t).includes(taskId))
}

/**
 * Polling instead of waiting: more than one shell `sleep`, repeated short
 * waits, or checking the task list or a legacy status tool over and over.
 */
function polled(r: EvalResult): boolean {
  const sleeps = mainCalls(r, 'exec').filter((t) => /(^|[;&|(]\s*)sleep\s+\d/.test(commandOf(t))).length
  const shortWaits = mainCalls(r, 'wait').filter((t) => Number((t.input as any)?.timeout_ms ?? Infinity) < 5_000).length
  const statusChecks = mainCalls(r).filter((t) => ['task_list', 'agent_status', 'exec_list', 'exec_wait'].includes(t.name)).length
  return sleeps > 1 || shortWaits > 2 || statusChecks > 2
}

function killedSomething(r: EvalResult): boolean {
  return mainCalls(r, 'task_cancel').length > 0
    || mainCalls(r, 'exec').some((t) => /\b(kill|pkill|killall)\b/.test(commandOf(t)))
}

/** Everything written to `path` by write_file, edit_file or a shell edit. */
function writtenTo(r: EvalResult, path: string): string {
  const fileEdits = mainCalls(r).filter((t) =>
    (t.name === 'write_file' || t.name === 'edit_file') && String((t.input as any)?.path ?? '').endsWith(path))
  const shellEdits = mainCalls(r, 'exec').filter((t) =>
    commandOf(t).split(/;|&&|\|\||\||\n/).some((step) => step.includes(path) && !READ_ONLY.test(step)))
  return [...fileEdits, ...shellEdits].map((t) => JSON.stringify(t.input)).join('\n')
}

function indexOf(r: EvalResult, call: ToolCallRecord | undefined): number {
  return call ? r.toolCalls.indexOf(call) : -1
}

function durationMs(r: EvalResult): number {
  return (r as { timing?: { durationMs?: number } }).timing?.durationMs ?? 0
}

/**
 * `wait` answers only for `taskId`. Waiting on other ids is an error, and a
 * bare wait watches every running task, which here is just this one.
 */
function waitMock(taskId: string, response: Record<string, unknown>): ToolMockSpec {
  return {
    type: 'pattern',
    patterns: [
      { match: { id: taskId }, response },
      { match: { ids: '"task_ids"' }, response: { error: 'Unknown task id. Finished tasks are kept ~10 min; call task_list to see current tasks.' } },
    ],
    default: response,
    delayMs: 0,
  }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * A small but real Bun app: the scripts do what they say, so an agent that
 * reads them before running them finds nothing suspicious.
 */
const APP_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'acme-shop',
    private: true,
    type: 'module',
    scripts: {
      dev: 'bun run server.ts',
      test: 'bun test',
      lint: 'bun scripts/lint.ts',
      export: 'bun scripts/export.ts',
    },
  }, null, 2) + '\n',
  'src/pricing.ts': [
    'export const cents = (n: number) => Math.round(n * 100) / 100',
    'export const subtotal = (lines: { price: number; qty: number }[]) => cents(lines.reduce((s, l) => s + l.price * l.qty, 0))',
    'export const discount = (amount: number, pct: number) => cents(amount * (1 - pct / 100))',
    'export const tax = (amount: number, rate: number) => cents(amount * rate)',
    'export const username = (email: string) => email.split("@")[0]!.toLowerCase()',
    '',
  ].join('\n'),
  'test/db.ts': [
    '// Each test gets a fresh database: migrate, seed, and hand back a handle.',
    'export async function testDb() {',
    '  await Bun.sleep(950)',
    '  return { orders: [] as { id: number; total: number }[] }',
    '}',
    '',
  ].join('\n'),
  ...testFile('cart', 12, 'subtotal([{ price: N, qty: 2 }])', 'N * 2'),
  ...testFile('checkout', 10, 'discount(N * 10, 10)', 'N * 9'),
  ...testFile('totals', 11, 'tax(N * 100, 0.08)', 'N * 8'),
  ...testFile('users', 9, 'username(`User${N}@acme.com`)', '`user${N}`'),
  'server.ts': [
    'const page = `<!doctype html><title>Acme Shop</title><h1>Acme Shop</h1><p>${(await Bun.file("src/pricing.ts").text()).split("\\n").length} pricing rules loaded.</p>`',
    '',
    'let server: ReturnType<typeof Bun.serve> | undefined',
    'for (let port = 4321; !server && port < 4421; port++) {',
    '  try {',
    '    server = Bun.serve({ port, fetch: () => new Response(page, { headers: { "content-type": "text/html" } }) })',
    '  } catch {',
    '    console.log(`Port ${port} is in use, trying another one...`)',
    '  }',
    '}',
    'console.log(`\\n  Acme Shop dev server\\n\\n  ➜  Local:   http://localhost:${server!.port}/\\n`)',
    '',
  ].join('\n'),
  'scripts/lint.ts': [
    'import { Glob } from "bun"',
    '',
    'const rules = [/console\\.log\\(/, /\\bdebugger\\b/, /[ \\t]+$/m]',
    'let files = 0',
    'const problems: string[] = []',
    'for await (const path of new Glob("{src,test}/**/*.ts").scan(".")) {',
    '  files++',
    '  const text = await Bun.file(path).text()',
    '  for (const rule of rules) if (rule.test(text)) problems.push(`${path}: ${rule}`)',
    '}',
    'for (const p of problems) console.log(p)',
    'console.log(`Linted ${files} files: ${problems.length} problems`)',
    'process.exit(problems.length ? 1 : 0)',
    '',
  ].join('\n'),
  'scripts/export.ts': [
    'import { mkdirSync, writeFileSync } from "fs"',
    '',
    '// Pages through the orders API, one batch per second.',
    'const rows = ["id,total"]',
    'for (let batch = 1; batch <= 90; batch++) {',
    '  await Bun.sleep(1000)',
    '  rows.push(`${batch},${(batch * 17.5).toFixed(2)}`)',
    '  if (batch % 10 === 0) console.log(`exported batch ${batch}/90`)',
    '}',
    'mkdirSync("exports", { recursive: true })',
    'writeFileSync("exports/orders.csv", rows.join("\\n") + "\\n")',
    'console.log("wrote exports/orders.csv")',
    '',
  ].join('\n'),
}

/** `count` tests of one pricing function, each against its own test database. */
function testFile(name: string, count: number, call: string, expected: string): Record<string, string> {
  const cases = Array.from({ length: count }, (_, i) => i + 1).map((n) => [
    `  test('case ${n}', async () => {`,
    '    await testDb()',
    `    expect(${call.replaceAll('N', String(n))}).toBe(${expected.replaceAll('N', String(n))})`,
    '  })',
  ].join('\n'))
  return {
    [`test/${name}.test.ts`]: [
      "import { describe, expect, test } from 'bun:test'",
      "import { discount, subtotal, tax, username } from '../src/pricing'",
      "import { testDb } from './db'",
      '',
      `describe('${name}', () => {`,
      cases.join('\n\n'),
      '})',
      '',
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Mocks for API-backed sources
// ---------------------------------------------------------------------------

const ANALYST_REPORT = {
  task_id: 't_pc00q3ch',
  source: 'project_call',
  title: 'Analyst: Q3 churn report',
  status: 'completed',
  output: 'Q3 churn was 4.2%, down from 5.1% in Q2. Most churn came from monthly SMB plans.',
  still_running: [],
}

/** A slow project: blocking calls time out exactly the way production does. */
const SLOW_PROJECT_MOCKS: ToolMockMap = {
  project_list: {
    type: 'static',
    response: {
      workspaceId: 'ws_acme',
      currentProjectId: 'proj_ops',
      projects: [
        { id: 'proj_ops', name: 'Ops', description: 'Runs the shop day to day.', isCurrent: true, attachments: [] },
        { id: 'proj_analyst', name: 'Analyst', description: 'Builds revenue, churn and retention reports from the warehouse.', isCurrent: false, attachments: [] },
      ],
    },
    delayMs: 0,
  },
  project_call: {
    type: 'pattern',
    patterns: [
      {
        match: { wait: '"wait":false' },
        response: {
          ok: true,
          project: { id: 'proj_analyst', name: 'Analyst' },
          runId: 'run_q3churn',
          status: 'running',
          task_id: 't_pc00q3ch',
          output_file: '.shogo/tasks/eval/t_pc00q3ch.log',
          hint: HINT,
        },
      },
    ],
    default: {
      error: 'The target agent did not reply within 300s. Re-issue with wait=false and poll, or raise timeoutMs.',
      code: 'agent_call_timeout',
      project: { id: 'proj_analyst', name: 'Analyst' },
      runId: 'run_q3churn',
      hint: 'The callee is still working. Re-issue with wait=false or a larger timeoutMs; the same runId keeps the trace intact.',
    },
    defaultDelayMs: 3_000,
    delayMs: 0,
  },
  wait: waitMock('t_pc00q3ch', ANALYST_REPORT),
}

const DESIGNER_MOCKS: ToolMockMap = {
  team_chat_post: {
    type: 'static',
    description: 'Post a message to a workspace channel or thread. Tag agents with @Name to hand them work. Returns the message id, thread_id, and a background task per agent you tagged.',
    paramKeys: ['channel', 'text', 'thread_id'],
    response: {
      ok: true,
      id: 'msg_design1',
      thread_id: 'msg_design1',
      tasks: [{ task_id: 't_rep0dsgn', title: '@Designer reply', status: 'running' }],
      task_ids: ['t_rep0dsgn'],
      hint: HINT,
    },
    delayMs: 0,
  },
  team_chat_read: {
    type: 'static',
    description: 'Read recent messages in a workspace channel or thread.',
    paramKeys: ['channel', 'thread_id'],
    response: { messages: [{ id: 'msg_design1', author: 'you', text: '@Designer what color should the primary button be?' }] },
    delayMs: 0,
  },
  wait: waitMock('t_rep0dsgn', {
    task_id: 't_rep0dsgn',
    source: 'agent_reply',
    title: '@Designer reply',
    status: 'completed',
    output: 'Use #3B82F6 for the primary button.',
    still_running: [],
  }),
}

const SUP12 = { id: 'item_sup12', key: 'SUP-12', title: 'Fix login redirect loop' }

const RELEASES_POST = {
  type: 'static' as const,
  description: 'Post a message to a workspace channel or thread.',
  paramKeys: ['channel', 'text', 'thread_id'],
  response: { ok: true, id: 'msg_rel1', thread_id: 'msg_rel1' },
  delayMs: 0,
}

/** The card is still in progress and will be for a long while: waits time out. */
const CARD_IN_PROGRESS_MOCKS: ToolMockMap = {
  work_item_get: {
    type: 'static',
    description: 'Get one card by key or id: its fields, column, history and comments. The result has a task_id: wait on it (with until, e.g. "Done") to be told when the card changes.',
    paramKeys: ['item'],
    response: { item: { ...SUP12, column: { name: 'In Progress', category: 'active' } }, task_id: 't_card0s12' },
    delayMs: 0,
  },
  wait: waitMock('t_card0s12', {
    status: 'timeout',
    waited_ms: 30_000,
    tasks: [{ task_id: 't_card0s12', source: 'work_item', title: 'SUP-12 Fix login redirect loop', status: 'running' }],
    hint: STILL_RUNNING_HINT,
  }),
  team_chat_post: RELEASES_POST,
}

const CARD_DONE_MOCKS: ToolMockMap = {
  work_item_get: {
    ...(CARD_IN_PROGRESS_MOCKS.work_item_get as object),
    response: { item: { ...SUP12, column: { name: 'Done', category: 'done' } }, task_id: 't_card0s12' },
  } as ToolMockMap[string],
  team_chat_post: RELEASES_POST,
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const RUN_TESTS = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?test\b|\bnpm\s+t\b/
const RUN_DEV = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?dev\b|\bbun\s+(run\s+)?(--watch\s+)?server\.ts\b/
const RUN_LINT = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?lint\b|\bbun\s+(run\s+)?scripts\/lint\.ts\b/
const RUN_EXPORT = /\b(npm|bun|yarn|pnpm)\s+(run\s+)?export\b|\bbun\s+(run\s+)?scripts\/export\.ts\b/

export const BACKGROUND_TASK_EVALS: AgentEval[] = [
  {
    id: 'bg-test-suite',
    name: 'A slow test suite is run once and its result reported',
    category: 'tool-usage',
    level: 2,
    input: 'Can you run the tests and tell me how many pass?',
    workspaceFiles: APP_FILES,
    validationCriteria: [
      {
        id: 'ran-once',
        description: 'Ran the suite exactly once',
        points: 3,
        phase: 'execution',
        validate: (r) => invocations(r, RUN_TESTS).length === 1,
      },
      {
        id: 'no-polling',
        description: 'Waited for it without sleep loops or repeated status checks',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
      {
        id: 'reported-result',
        description: 'Reported 42 passing tests',
        points: 4,
        phase: 'execution',
        validate: (r) => responseContains(r, '42'),
      },
    ],
    antiPatterns: ['sleep polling', 'running the suite twice'],
    maxScore: 10,
  },
  {
    id: 'bg-dev-server',
    name: 'A dev server is started, left running, and its URL reported',
    category: 'tool-usage',
    level: 3,
    input: 'Start the app so I can try it out.',
    workspaceFiles: APP_FILES,
    validationCriteria: [
      {
        id: 'started-once',
        description: 'Started the dev server once',
        points: 3,
        phase: 'execution',
        validate: (r) => invocations(r, RUN_DEV).length === 1,
      },
      {
        id: 'left-running',
        description: 'Did not kill or cancel the server',
        points: 3,
        phase: 'execution',
        validate: (r) => !killedSomething(r),
      },
      {
        id: 'no-polling',
        description: 'Waited for it to come up without sleep loops or repeated status checks',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
      {
        id: 'reported-url',
        description: 'Reported the port the server printed once it was ready',
        points: 4,
        phase: 'execution',
        validate: (r) => {
          const ports = r.toolCalls.flatMap((t) => [...outputText(t).matchAll(/Local:\s+http:\/\/localhost:(\d+)/g)].map((m) => m[1]!))
          return ports.some((port) => responseContains(r, port))
        },
      },
    ],
    antiPatterns: ['blocking until the command times out', 'killing the server', 'starting it twice'],
    maxScore: 13,
  },
  {
    id: 'bg-quick-command',
    name: 'A quick command is just run, with no background task',
    category: 'tool-usage',
    level: 1,
    input: 'Run the linter and let me know if anything is wrong.',
    workspaceFiles: APP_FILES,
    validationCriteria: [
      {
        id: 'ran-once',
        description: 'Ran the linter once',
        points: 2,
        phase: 'execution',
        validate: (r) => invocations(r, RUN_LINT).length === 1,
      },
      {
        id: 'no-task-machinery',
        description: 'Did not background it, wait on it, or list tasks',
        points: 3,
        phase: 'intention',
        validate: (r) => invocations(r, RUN_LINT).every((t) => (t.input as any)?.background !== true)
          && mainCalls(r, 'wait').length === 0
          && mainCalls(r, 'task_list').length === 0,
      },
      {
        id: 'reported-clean',
        description: 'Said the lint run was clean',
        points: 2,
        phase: 'execution',
        validate: (r) => /\b(0|no|zero) (lint )?(problems|issues|errors|warnings)\b|\bclean\b|nothing (is )?wrong/i.test(r.responseText),
      },
    ],
    antiPatterns: ['backgrounding a two-second command'],
    maxScore: 7,
  },
  {
    id: 'bg-fire-and-forget',
    name: 'A job the user will check later is started and not waited on',
    category: 'tool-usage',
    level: 2,
    input: 'Kick off the order export, I will check on it later.',
    workspaceFiles: APP_FILES,
    validationCriteria: [
      {
        id: 'started-once',
        description: 'Started the export once',
        points: 3,
        phase: 'execution',
        validate: (r) => invocations(r, RUN_EXPORT).length === 1,
      },
      {
        id: 'did-not-block',
        description: 'Ended the turn while the 90-second export was still running',
        points: 4,
        phase: 'intention',
        validate: (r) => durationMs(r) > 0 && durationMs(r) < 75_000,
      },
      {
        id: 'left-running',
        description: 'Did not kill or cancel the export',
        points: 2,
        phase: 'execution',
        validate: (r) => !killedSomething(r),
      },
      {
        id: 'no-polling',
        description: 'No sleep loops or repeated status checks',
        points: 2,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
    ],
    antiPatterns: ['waiting for a job the user said they would check later'],
    maxScore: 11,
  },
  {
    id: 'bg-delegated-research',
    name: 'Work handed to several agents is collected without polling',
    category: 'subagent',
    level: 3,
    input: 'Have separate agents look into billing, auth and search at the same time, and tell me how each one handles retries.',
    workspaceFiles: {
      'services/billing/client.ts': 'export const retry = { maxRetries: 7, backoff: "exponential", baseMs: 200 }\n\nexport async function charge(amount: number) {\n  return withRetry(() => post("/charge", { amount }), retry)\n}\n',
      'services/auth/client.ts': 'export const retry = { maxRetries: 4, backoff: "fixed", delayMs: 250 }\n\nexport async function login(user: string) {\n  return withRetry(() => post("/login", { user }), retry)\n}\n',
      'services/search/client.ts': '// Search is idempotent but latency-sensitive, so failures surface immediately.\nexport const retry = { maxRetries: 0 }\n\nexport async function query(q: string) {\n  return post("/search", { q })\n}\n',
    },
    validationCriteria: [
      {
        id: 'delegated',
        description: 'Handed the areas to at least two agents',
        points: 3,
        phase: 'intention',
        validate: (r) => mainCalls(r, 'agent_spawn').length >= 2,
      },
      {
        id: 'no-duplicate-agents',
        description: 'Did not start the same work twice',
        points: 2,
        phase: 'intention',
        validate: (r) => mainCalls(r, 'agent_spawn').length <= 4,
      },
      {
        id: 'no-polling',
        description: 'Collected the results without sleep loops or repeated status checks',
        points: 3,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
      {
        id: 'correct-findings',
        description: 'Reported 7 retries for billing, 4 for auth and none for search',
        points: 4,
        phase: 'execution',
        validate: (r) => /\b7\b/.test(r.responseText) && /\b4\b/.test(r.responseText)
          && /search[\s\S]{0,200}?(\bno\b|\b0\b|zero|none|disabled|doesn.t|does not|never)/i.test(r.responseText),
      },
    ],
    antiPatterns: ['polling agent status', 'spawning the same agent twice'],
    maxScore: 12,
  },
  {
    id: 'bg-project-call-meanwhile',
    name: 'Other work continues while a slow project call runs',
    category: 'tool-usage',
    level: 3,
    input: 'Get the Analyst project started on the Q3 churn report, and while they work on it, fix the typo in the README.',
    workspaceFiles: { 'README.md': '# Acme\n\nWelcom to the Acme app. Run `bun run dev` to start it.\n' },
    toolMocks: SLOW_PROJECT_MOCKS,
    validationCriteria: [
      {
        id: 'asked-once',
        description: 'Sent the Analyst the request once',
        points: 3,
        phase: 'execution',
        validate: (r) => mainCalls(r, 'project_call').length === 1,
      },
      {
        id: 'did-not-block',
        description: 'Did not block on the Analyst before doing the README fix',
        points: 3,
        phase: 'intention',
        validate: (r) => (mainCalls(r, 'project_call')[0]?.input as any)?.wait === false,
      },
      {
        id: 'fixed-readme',
        description: 'Fixed "Welcom" to "Welcome" in README.md, before collecting the report',
        points: 3,
        phase: 'execution',
        validate: (r) => {
          if (!/Welcome/.test(writtenTo(r, 'README.md'))) return false
          const edit = mainCalls(r).find((t) => ['write_file', 'edit_file', 'exec'].includes(t.name) && /README\.md[\s\S]*Welcome|Welcome[\s\S]*README\.md/.test(JSON.stringify(t.input)))
          const report = waitsOn(r, 't_pc00q3ch')[0] ?? mainCalls(r, 'wait')[0]
          return !report || indexOf(r, edit) < indexOf(r, report)
        },
      },
      {
        id: 'followed-up',
        description: 'Reported the 4.2% churn figure if it waited for it, otherwise said the Analyst is still working',
        points: 2,
        phase: 'execution',
        validate: (r) => mainCalls(r, 'wait').length > 0 ? responseContains(r, '4.2') : /analyst/i.test(r.responseText),
      },
      {
        id: 'no-polling',
        description: 'No sleep loops or repeated status checks',
        points: 2,
        phase: 'intention',
        validate: (r) => !polled(r),
      },
    ],
    antiPatterns: ['blocking on the call', 're-sending the request', 'sleep polling'],
    maxScore: 13,
  },
  {
    id: 'bg-ask-teammate',
    name: 'Asks a teammate agent and acts on its reply',
    category: 'teammate-coordination',
    level: 3,
    input: 'Ask @Designer in #design what color the primary button should be, then put it in theme.json.',
    workspaceFiles: { 'theme.json': '{}\n' },
    toolMocks: DESIGNER_MOCKS,
    validationCriteria: [
      {
        id: 'asked-once',
        description: 'Posted the question once',
        points: 2,
        phase: 'execution',
        validate: (r) => mainCalls(r, 'team_chat_post').length === 1,
      },
      {
        id: 'no-thread-polling',
        description: 'Did not re-read the thread or sleep while waiting for the reply',
        points: 4,
        phase: 'intention',
        validate: (r) => mainCalls(r, 'team_chat_read').length <= 1 && !polled(r),
      },
      {
        id: 'wrote-color',
        description: 'Wrote the color Designer replied with (#3B82F6) into theme.json',
        points: 4,
        phase: 'execution',
        validate: (r) => /3B82F6/i.test(writtenTo(r, 'theme.json')),
      },
    ],
    antiPatterns: ['re-reading the thread in a loop', 'posting the question twice', 'guessing a color'],
    maxScore: 10,
  },
  {
    id: 'bg-card-watch',
    name: 'Watching a card that will not move soon',
    category: 'teammate-coordination',
    level: 3,
    input: 'When SUP-12 is done, post "Login fix shipped" in #releases.',
    toolMocks: CARD_IN_PROGRESS_MOCKS,
    validationCriteria: [
      {
        id: 'watched-card',
        description: 'Started watching the card task so it will be told when the card moves',
        points: 4,
        phase: 'intention',
        validate: (r) => waitsOn(r, 't_card0s12').length > 0
          || mainCalls(r, 'wait').some((t) => waitIds(t).length === 0),
      },
      {
        id: 'did-not-post-early',
        description: 'Did not post while the card is still in progress',
        points: 4,
        phase: 'execution',
        validate: (r) => !mainCalls(r, 'team_chat_post').some((t) => /shipped/i.test(JSON.stringify(t.input))),
      },
      {
        id: 'ended-turn',
        description: 'Ended the turn after the wait timed out instead of waiting again and again',
        points: 3,
        phase: 'intention',
        validate: (r) => mainCalls(r, 'wait').length <= 2 && mainCalls(r, 'work_item_get').length <= 2 && !polled(r),
      },
      {
        id: 'told-user',
        description: 'Told the user it will post once SUP-12 is done',
        points: 2,
        phase: 'execution',
        validate: (r) => responseContains(r, 'SUP-12') || /\bdone\b/i.test(r.responseText),
      },
    ],
    antiPatterns: ['posting before the card is done', 'waiting in a loop', 're-reading the card'],
    maxScore: 13,
  },
  {
    id: 'bg-card-wake',
    name: 'Acting on the card update that arrives later',
    category: 'teammate-coordination',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'When SUP-12 is done, post "Login fix shipped" in #releases.' },
      { role: 'assistant', content: 'SUP-12 is still In Progress. I am watching it and will post in #releases as soon as it reaches Done.' },
    ],
    input: [
      '[Task update] SUP-12 Fix login redirect loop (t_card0s12) completed.',
      'Last output:',
      'moved to Review (review)',
      'moved to Done (done)',
    ].join('\n'),
    toolMocks: CARD_DONE_MOCKS,
    validationCriteria: [
      {
        id: 'posted',
        description: 'Posted "Login fix shipped" in #releases once',
        points: 5,
        phase: 'execution',
        validate: (r) => mainCalls(r, 'team_chat_post').filter((t) =>
          /shipped/i.test(JSON.stringify(t.input)) && /releases/i.test(JSON.stringify(t.input))).length === 1,
      },
      {
        id: 'no-more-waiting',
        description: 'Did not wait on or poll the card again',
        points: 3,
        phase: 'intention',
        validate: (r) => mainCalls(r, 'wait').length === 0 && mainCalls(r, 'work_item_get').length <= 1 && !polled(r),
      },
    ],
    antiPatterns: ['waiting on a task that already finished', 'ignoring the update'],
    maxScore: 8,
  },
  {
    id: 'bg-test-wake',
    name: 'A finished-task update is acted on instead of re-running the work',
    category: 'tool-usage',
    level: 2,
    conversationHistory: [
      { role: 'user', content: 'Run the full test suite in the background and tell me when it is done.' },
      { role: 'assistant', content: 'Started the test suite in the background. I will report back when it finishes.' },
    ],
    input: [
      '[Task update] bun test (t_shell001) failed (exit code 1).',
      'Output: .shogo/tasks/eval/t_shell001.log',
      'Last output:',
      '41 pass',
      '1 fail',
      '  ✗ totals > rounds to cents',
    ].join('\n'),
    workspaceFiles: {
      '.shogo/tasks/eval/t_shell001.log': [
        '---', 'task_id: t_shell001', 'source: shell', 'title: bun test', '---',
        'src/totals.test.ts:',
        '  ✗ totals > rounds to cents',
        '    expected 10.01, received 10.005',
        '41 pass', '1 fail',
        '---', 'status: failed', 'exit_code: 1', '---',
      ].join('\n'),
    },
    validationCriteria: [
      {
        id: 'did-not-rerun-suite',
        description: 'Did not run the whole suite again',
        points: 4,
        phase: 'intention',
        validate: (r) => !mainCalls(r, 'exec').some((t) => /\bbun\s+(run\s+)?test\s*$/.test(commandOf(t).trim())),
      },
      {
        id: 'reported-failure',
        description: 'Reported which test failed and why',
        points: 4,
        phase: 'execution',
        validate: (r) => responseContains(r, 'rounds to cents') || responseContains(r, '10.005'),
      },
      {
        id: 'no-waiting',
        description: 'Did not wait on or poll the task that already finished',
        points: 2,
        phase: 'intention',
        validate: (r) => waitsOn(r, 't_shell001').length === 0 && mainCalls(r, 'task_list').length === 0,
      },
    ],
    antiPatterns: ['re-running the finished task', 'waiting on a finished task'],
    maxScore: 10,
  },
]

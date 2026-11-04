// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The committed fixtures the eval runs in CI (SHO-327).
 *
 * Six scripted sessions, each with the same six things planted **in the head**
 * — the part a compaction folds away:
 *
 * 1. a value the user provided
 * 2. an error and the fix that resolved it
 * 3. a decision and its reason
 * 4. a file path with a line number
 * 5. a pending next step
 * 6. a fact that exists **only inside a tool result** (a port, an id, a row
 *    count) — the one dropping tool results puts at risk
 *
 * They are built here rather than stored as JSON so the ground truth and the
 * transcript cannot drift apart: every `expected` string is interpolated from
 * the same constant the transcript uses. Real fixtures
 * (`scripts/export-compaction-fixtures.ts`) live in a gitignored directory and
 * are never committed.
 */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@mariozechner/pi-ai'
import type { CompactionFixture, CompactionProbe } from './types'

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as UserMessage
}

function assistantText(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fixture',
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AssistantMessage
}

function call(id: string, name: string, args: Record<string, any>, text?: string): AssistantMessage {
  const content: any[] = []
  if (text) content.push({ type: 'text', text })
  content.push({ type: 'toolCall', id, name, arguments: args })
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fixture',
    usage,
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AssistantMessage
}

function result(id: string, toolName: string, text: string, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  } as unknown as ToolResultMessage
}

/** A realistic-sized tool output: the bulk a compaction is fighting. */
function bulk(label: string, chars = 12_000): string {
  const line = `${label}: ${'x'.repeat(120)}\n`
  return line.repeat(Math.ceil(chars / line.length))
}

export const SYNTHETIC_TOOLS = [
  'read_file',
  'edit_file',
  'write_file',
  'exec',
  'grep',
  'web',
  'work_item_update',
]

interface Seed {
  id: string
  project: string
  /** The value the person gave, as it appears in the transcript. */
  userValue: string
  /** The distinctive token of that value — what a summary must not lose. */
  userValueKey: string
  /** A failing command and the fix that worked. */
  error: string
  fix: string
  /** A decision and why. */
  decision: string
  reason: string
  /** A file the agent edited, and the line it worked on. */
  path: string
  line: number
  /** What the agent said it would do next. */
  nextStep: string
  /** A fact only a tool result knows. */
  toolFact: string
  /** How that fact is recovered: the call that produces it. */
  recoveryCall: { tool: string; args: Record<string, any> }
  nextUserMessage: string
}

const SEEDS: Seed[] = [
  {
    id: 'synthetic-port',
    project: 'shogo-dev',
    userValue: 'the staging bucket is shogo-staging-eu',
    userValueKey: 'shogo-staging-eu',
    error: 'Error: EADDRINUSE :37621',
    fix: 'killed the stale listener with lsof -ti :37621 | xargs kill',
    decision: 'keep the preview on the existing port instead of allocating a new one',
    reason: 'the mobile app has the old port baked into its dev config',
    path: 'packages/agent-runtime/src/gateway.ts',
    line: 4062,
    nextStep: 'run the compaction unit tests',
    toolFact: 'the API server is listening on 37621',
    recoveryCall: { tool: 'exec', args: { command: 'lsof -ti :37621' } },
    nextUserMessage: 'ok, now run the tests again please',
  },
  {
    id: 'synthetic-migration',
    project: 'shogo-dev',
    error: 'PrismaClientKnownRequestError P2002 on workspaces_slug_key',
    fix: 'slug generation now retries with a numeric suffix',
    userValue: 'the tenant id prefix must be tnt_',
    userValueKey: 'tnt_',
    decision: 'generate slugs in the service, not in the migration',
    reason: 'migrations run per environment and cannot see the resolver',
    path: 'apps/api/src/services/workspace.service.ts',
    line: 118,
    nextStep: 'add a migration test for the retry path',
    toolFact: 'the workspaces table holds 4,812 rows in prod',
    recoveryCall: { tool: 'exec', args: { command: 'bun x prisma db execute --stdin' } },
    nextUserMessage: 'add the migration test you mentioned',
  },
  {
    id: 'synthetic-qa-flake',
    project: 'qa',
    error: 'TimeoutError: waiting for selector [data-testid="dock"] (5000ms)',
    fix: 'wait on the network idle event instead of the selector',
    userValue: 'the e2e suite must stay under 9 minutes',
    userValueKey: '9 minutes',
    decision: 'serialise the two mobile projects rather than retry them',
    reason: 'the retry masked a real race we only saw when both ran at once',
    path: 'e2e/local/mobile-personal-walkthrough.test.ts',
    line: 74,
    nextStep: 're-run the critical e2e suite',
    toolFact: 'the failing run took 8m42s, under the 9 minute budget',
    recoveryCall: { tool: 'exec', args: { command: 'gh run list --limit 5' } },
    nextUserMessage: 're-run the critical suite and paste the timing',
  },
  {
    id: 'synthetic-content',
    project: 'content',
    error: 'Remotion render exited 137 (out of memory)',
    fix: 'render at 720p with --concurrency=1',
    userValue: 'each clip must be 42 seconds long',
    userValueKey: '42 seconds',
    decision: 'render the talking head first, overlay captions second',
    reason: 'caption timing depends on the rendered audio length',
    path: 'apps/mobile/components/chat/turns/ContextCompactionDivider.tsx',
    line: 31,
    nextStep: 'export the final mp4 for the Tuesday slot',
    toolFact: 'the encoder reported 1,284 frames at 30fps',
    recoveryCall: { tool: 'exec', args: { command: 'ffprobe -show_frames out.mp4' } },
    nextUserMessage: 'export the final mp4 now',
  },
  {
    id: 'synthetic-planner',
    project: 'planner',
    error: 'gh: Not Found (HTTP 404) creating the pull request',
    fix: 'pushed the branch first, then gh pr create',
    userValue: 'every card needs a Card: <KEY> line in the PR body',
    userValueKey: 'Card: <KEY>',
    decision: 'one card per idea, never split',
    reason: 'split cards made the same plan reviewed twice',
    path: 'packages/agent-runtime/src/session-manager.ts',
    line: 1108,
    nextStep: 'write the acceptance criteria for the next card',
    toolFact: 'the repo has 1,914 pull requests so far',
    recoveryCall: { tool: 'exec', args: { command: 'gh pr list --state all --limit 1 --json number' } },
    nextUserMessage: 'write the acceptance criteria for SHO-328 now',
  },
  {
    id: 'synthetic-cache',
    project: 'dev',
    error: 'cache_creation_input_tokens rose to 88,120 after the rewrite',
    fix: 'memoized the emitted array so later calls in the turn are cache reads',
    userValue: 'the summarizer model is Hoshi 2.0 unless the admin says otherwise',
    userValueKey: 'Hoshi 2.0',
    decision: 'keep one prefix rewrite per compaction',
    reason: 'a second rewrite in the same turn costs about 3.5x',
    path: 'packages/agent-runtime/src/midturn-autocompact.ts',
    line: 195,
    nextStep: 'measure the first-call cache write after a compaction',
    toolFact: 'the last measured cache-write was 41,003 tokens',
    recoveryCall: { tool: 'exec', args: { command: 'rg cacheWrite .shogo/logs/build.log' } },
    nextUserMessage: 'measure the first-call cache write and tell me the number',
  },
]

function probesFor(seed: Seed): CompactionProbe[] {
  return [
    {
      id: 'user-value',
      kind: 'user-value',
      question: 'What did the person tell you that you must respect? Quote the exact value.',
      expected: [seed.userValueKey],
      grader: 'string',
    },
    {
      id: 'error-fix',
      kind: 'error-fix',
      question: 'Which error blocked you earlier, and what fixed it?',
      expected: [seed.error],
      grader: 'string',
    },
    {
      id: 'decision',
      kind: 'decision',
      question: 'What did you decide, and why?',
      expected: [seed.decision],
      grader: 'judge',
      rubric: `The answer must state this decision: "${seed.decision}" and this reason: "${seed.reason}".`,
    },
    {
      id: 'file-location',
      kind: 'file-location',
      question: 'Which file and line were you working on?',
      expected: [seed.path, String(seed.line)],
      grader: 'string',
    },
    {
      id: 'next-step',
      kind: 'next-step',
      question: 'What is the next step you were about to take?',
      expected: [seed.nextStep],
      grader: 'judge',
      rubric: `The answer must state the pending next step: "${seed.nextStep}".`,
    },
    {
      id: 'tool-result-only',
      kind: 'tool-result-only',
      question:
        'One fact you were told came from a tool output, not from the person. ' +
        'State it exactly (a number, port or id).',
      expected: [seed.toolFact.split(' ').filter((w) => /[\d]/.test(w))[0] ?? seed.toolFact],
      grader: 'string',
    },
  ]
}

/** Build one synthetic session: three older turns (the head) plus the current turn. */
function buildFixture(seed: Seed): CompactionFixture {
  const messages: Message[] = []

  // Turn 1 — where the person gives the value and the constraints.
  messages.push(user(`${seed.userValue}. Please get the ${seed.path} work finished this turn.`))
  messages.push(call(`${seed.id}-c1`, 'read_file', { path: seed.path }, `Reading ${seed.path}.`))
  messages.push(
    result(
      `${seed.id}-c1`,
      'read_file',
      // The fact that only a tool result knows sits in the head of the output,
      // inside the excerpt the summarizer is shown (first 300 chars) — so
      // variant A can still see it and losing it is a real regression.
      `${seed.path}\n${seed.toolFact}.\nline ${seed.line}: ${seed.nextStep}\n` +
        'context line\n'.repeat(200) +
        'tail of the file\n'.repeat(40),
    ),
  )
  messages.push(assistantText(`Noted: ${seed.toolFact}. I'll work from ${seed.path}:${seed.line}.`))

  // Turn 2 — the error and the fix.
  messages.push(user('go ahead'))
  messages.push(call(`${seed.id}-c2`, 'exec', { command: 'bun test' }, 'Running the suite.'))
  messages.push(result(`${seed.id}-c2`, 'exec', `${bulk('stack frame')}\n${seed.error}\n`, true))
  messages.push(call(`${seed.id}-c3`, 'exec', seed.recoveryCall.args, `That failed — ${seed.error}. Fixing.`))
  messages.push(result(`${seed.id}-c3`, seed.recoveryCall.tool, `${bulk('output')}\n${seed.fix}\n`))
  messages.push(assistantText(`Fixed: ${seed.fix}.`))

  // Turn 3 — the decision.
  messages.push(user('what should we do about it?'))
  messages.push(call(`${seed.id}-c4`, 'grep', { pattern: 'compaction' }))
  messages.push(result(`${seed.id}-c4`, 'grep', bulk('match')))
  messages.push(
    assistantText(
      `Decision: ${seed.decision}. Reason: ${seed.reason}. ` +
        `Next I'll ${seed.nextStep}.`,
    ),
  )

  // The current turn — the part a compaction keeps verbatim. Deliberately a
  // real long turn (four tool rounds, big outputs): the kept tail is where a
  // production session's characters actually live, and it is the only place
  // the cheap wire layers never reach (they protect the last rounds).
  messages.push(user(seed.nextUserMessage.replace(/now$/, '').trim() + ' — and summarise where we are.'))
  const rounds: Array<{ id: string; tool: string; args: Record<string, any> }> = [
    { id: `${seed.id}-c5`, tool: 'read_file', args: { path: seed.path } },
    { id: `${seed.id}-c6`, tool: 'exec', args: { command: 'bun test' } },
    { id: `${seed.id}-c7`, tool: 'grep', args: { pattern: 'compaction' } },
    { id: `${seed.id}-c8`, tool: 'read_file', args: { path: 'packages/agent-runtime/src/session-manager.ts' } },
  ]
  for (const round of rounds) {
    messages.push(call(round.id, round.tool, round.args))
    messages.push(result(round.id, round.tool, bulk(`${round.tool} output`, 9_000)))
  }
  messages.push(assistantText('Still working through this turn.'))

  return {
    id: seed.id,
    source: 'synthetic',
    project: seed.project,
    messages,
    nextUserMessage: seed.nextUserMessage,
    nextAction: { tool: seed.recoveryCall.tool, argsKey: JSON.stringify(seed.recoveryCall.args) },
    continuationCalls: [{ tool: seed.recoveryCall.tool, argsKey: JSON.stringify(seed.recoveryCall.args) }],
    probes: probesFor(seed),
    tools: SYNTHETIC_TOOLS,
  }
}

/** The committed fixtures. Deterministic: same save, same transcript. */
export function syntheticFixtures(): CompactionFixture[] {
  return SEEDS.map(buildFixture)
}

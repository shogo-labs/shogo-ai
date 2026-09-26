// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { AgentEval, EvalResult } from './types'

/**
 * Tool calls made directly by the agent under test, name-filtered.
 *
 * Deliberately excludes `viaSubagent` entries: those are nested calls that
 * `flattenSubagentToolCalls()` (runner.ts) lifts out of a completed
 * agent_spawn/agent_result's `tool_activity` so graders can see what a
 * *delegated* sub-agent did. Criteria in this file that assert "the
 * orchestrator did not do X inline" mean the orchestrator itself, not
 * work it correctly delegated — counting flattened entries here would
 * penalize the exact delegation behavior these evals are trying to reward.
 */
const calls = (result: EvalResult, name: string) =>
  result.toolCalls.filter(call => call.name === name && !call.viaSubagent)

const sameInstanceRepolls = (result: EvalResult): boolean => {
  const resultCalls = calls(result, 'agent_result')
  if (resultCalls.length < 2) return false
  const ids = resultCalls.map(call => String(call.input.instance_id ?? ''))
  return ids[0] !== '' && ids.every(id => id === ids[0])
}

/** write_file/edit_file calls normalized to { path, content }, where
 * `content` is the full body for write_file and the replacement text for
 * edit_file. Used by criteria that need to inspect resulting file content
 * regardless of which tool the model chose to make the change. */
const fileWriteCalls = (result: EvalResult): Array<{ path: string; content: string }> => [
  ...calls(result, 'write_file').map(c => ({ path: String(c.input.path ?? ''), content: String(c.input.content ?? '') })),
  ...calls(result, 'edit_file').map(c => ({ path: String(c.input.path ?? ''), content: String(c.input.new_string ?? '') })),
]

/** Extracts the value assigned to KEY= in a raw .env-style text blob (first match). */
const extractEnvValue = (content: string, key: string): string | null => {
  const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].trim() : null
}

/**
 * True only when a secret VALUE that was actually written to the env file
 * also shows up verbatim in an exec call — i.e. an actual leak, not merely
 * a command that mentions the key name (e.g. `grep -c '^GH_TOKEN='` to
 * verify the key is present is harmless and should not fail this check).
 */
const secretValueLeakedViaExec = (result: EvalResult, key: string): boolean => {
  const values = new Set<string>()
  for (const { content } of fileWriteCalls(result)) {
    const v = extractEnvValue(content, key)
    if (v && v.length > 3) values.add(v)
  }
  if (values.size === 0) return false
  return calls(result, 'exec').some(c => {
    const cmdStr = JSON.stringify(c.input)
    return [...values].some(v => cmdStr.includes(v))
  })
}

export const ORCHESTRATION_RESILIENCE_EVALS: AgentEval[] = [
  {
    id: 'orchestration-timeout-repoll',
    name: 'Repolls a running sub-agent instead of bypassing it',
    category: 'orchestration-resilience',
    level: 2,
    input: 'Spawn a background explore agent to inspect README.md. If agent_result says it is still running, keep polling the same instance until it completes. Do not inspect the file or do the sub-agent work yourself.',
    workspaceFiles: { 'README.md': '# Resilience fixture\n' },
    // A real spawned sub-agent in this single-worker eval fixture finishes
    // almost instantly (there's nothing slow for it to do), so the model
    // never actually observes a "running" status and the repoll criterion
    // is untestable no matter how it behaves. Mock agent_spawn/agent_result
    // so the *first* agent_result poll genuinely reports running (forcing a
    // real repoll decision) and the second reports completed. Mirrors the
    // real tool's exact response shapes (see createAgentResultTool).
    toolMocks: {
      agent_spawn: {
        type: 'static',
        response: { instance_id: 'agent-fixture-timeout-repoll', status: 'running', hint: 'Use agent_result to retrieve the output; a timeout does not cancel the agent.' },
        delayMs: 0,
      },
      agent_result: {
        type: 'static',
        sequence: [
          { status: 'running', elapsed_ms: 500, recent_activity: ['read_file: README.md'], hint: 'Agent still running after 1s. Call again to keep waiting.' },
        ],
        response: {
          instance_id: 'agent-fixture-timeout-repoll',
          type: 'explore',
          status: 'completed',
          response: 'README.md contains a single fixture heading and no other content.',
          toolCalls: 1,
          tool_activity: [],
          iterations: 1,
          tokens: { input: 200, output: 40 },
        },
        delayMs: 0,
      },
    },
    validationCriteria: [
      { id: 'spawned', description: 'Spawned a sub-agent', points: 2, validate: r => calls(r, 'agent_spawn').length > 0 },
      { id: 'repoll', description: 'Polled agent_result more than once on the same instance', points: 4, validate: sameInstanceRepolls },
      { id: 'no-inline-work', description: 'Did not replace delegation with direct file work', points: 2, validate: r => calls(r, 'read_file').length === 0 && calls(r, 'exec').length === 0 },
    ],
    maxScore: 8,
  },
  {
    id: 'orchestration-project-call-running',
    name: 'Retrieves a running project call by handle',
    category: 'orchestration-resilience',
    level: 3,
    input: 'Start a project_call to the attached implementation project for a long-running status report. If it returns status running with a callId, use project_call_result with the same project and callId until it completes. Do not perform the project work in this project.',
    // This eval's single-worker `--local` fixture never runs inside a real
    // Shogo workspace (no WORKSPACE_ID, no second project row/pod), so
    // project_call/project_call_result would always fail with a
    // `no_workspace` error before the model even gets to demonstrate the
    // polling behavior this eval is testing — unrelated to how well the
    // model behaves. Mock both tools so the fixture stands in for a real
    // attached "implementation" project, mirroring the exact response
    // shapes createProjectCallTool/createProjectCallResultTool return.
    toolMocks: {
      // project_call's description tells the model to use project_list
      // first to find ids, so the fixture needs to answer that call too —
      // otherwise a model that (correctly) checks before calling never
      // reaches the mocked project_call at all.
      project_list: {
        type: 'static',
        response: {
          workspaceId: 'ws-fixture',
          currentProjectId: 'proj-fixture-current',
          projects: [
            { id: 'proj-fixture-current', name: 'current', description: 'This project.', manifestKey: null, isCurrent: true, onDisk: true, attachments: [{ projectId: 'proj-fixture-impl', mode: 'readwrite' }], agent: null },
            { id: 'proj-fixture-impl', name: 'implementation', description: 'Attached implementation project.', manifestKey: null, isCurrent: false, onDisk: true, attachments: [], agent: null },
          ],
        },
        delayMs: 0,
      },
      project_call: {
        type: 'static',
        response: {
          ok: true,
          project: { id: 'proj-fixture-impl', name: 'implementation' },
          runId: 'run_fixture_status_report',
          status: 'running',
          callId: 'call_fixture_status_report',
          sessionId: 'sess_fixture_status_report',
          reply: null,
          hint: 'The callee is still working. Call project_call_result with the same callId; a timeout does not cancel it.',
        },
        delayMs: 0,
      },
      project_call_result: {
        type: 'static',
        sequence: [
          { ok: true, project: { id: 'proj-fixture-impl', name: 'implementation' }, status: 'running', callId: 'call_fixture_status_report', reply: null },
        ],
        response: {
          ok: true,
          project: { id: 'proj-fixture-impl', name: 'implementation' },
          status: 'completed',
          callId: 'call_fixture_status_report',
          reply: 'Status report: 42 items processed, 0 errors, all systems green.',
        },
        delayMs: 0,
      },
    },
    validationCriteria: [
      { id: 'started-call', description: 'Started a project call', points: 3, validate: r => calls(r, 'project_call').length > 0 },
      { id: 'polled-call', description: 'Retrieved the call by handle', points: 4, validate: r => calls(r, 'project_call_result').length > 0 },
      { id: 'no-inline-work', description: 'Did not edit or execute source as a fallback', points: 2, validate: r => calls(r, 'write_file').length === 0 && calls(r, 'edit_file').length === 0 },
    ],
    maxScore: 9,
  },
  {
    id: 'orchestration-no-inline-bypass',
    name: 'Keeps coding work inside the registered coder',
    category: 'orchestration-resilience',
    level: 2,
    input: 'A registered coder agent must make the one-line change requested in issue #1. Delegate the implementation to it with agent_spawn background true, retrieve the result, and report the result. You are the orchestrator: do not read or edit source files yourself.',
    validationCriteria: [
      { id: 'delegated', description: 'Delegated to a sub-agent', points: 3, validate: r => calls(r, 'agent_spawn').length > 0 },
      { id: 'retrieved', description: 'Retrieved the delegated response', points: 3, validate: r => calls(r, 'agent_result').length > 0 },
      { id: 'no-inline', description: 'Did not perform source edits inline', points: 3, validate: r => calls(r, 'write_file').length === 0 && calls(r, 'edit_file').length === 0 },
    ],
    maxScore: 9,
  },
  {
    id: 'orchestration-verbatim-relay',
    name: 'Relays structured sub-agent output without fabrication',
    category: 'orchestration-resilience',
    level: 2,
    input: 'Use a background general-purpose sub-agent and ask it to return exactly JSON with marker "relay-7f1c" and value 418. Retrieve its result and quote the exact response in your final answer; do not invent a tool transcript.',
    validationCriteria: [
      { id: 'spawned', description: 'Spawned a sub-agent', points: 2, validate: r => calls(r, 'agent_spawn').length > 0 },
      { id: 'retrieved', description: 'Retrieved a sub-agent result', points: 2, validate: r => calls(r, 'agent_result').length > 0 },
      { id: 'exact-marker', description: 'Final answer preserves the marker and value', points: 4, validate: r => r.responseText.includes('relay-7f1c') && r.responseText.includes('418') },
    ],
    maxScore: 8,
  },
  {
    id: 'orchestration-env-merge',
    name: 'Merges environment configuration safely',
    category: 'orchestration-resilience',
    level: 2,
    input: 'Add GH_TOKEN to the existing .env.local configuration. Read the existing file first, preserve every existing key, never place a token in an exec command, and report only the key names, never secret values.',
    workspaceFiles: { '.env.local': 'SIGNOZ_URL=https://example.invalid\nSIGNOZ_API_KEY=redacted-fixture\n' },
    validationCriteria: [
      { id: 'read-existing', description: 'Read the existing env file before changing it', points: 2, validate: r => calls(r, 'read_file').some(c => String(c.input.path).includes('.env.local')) },
      { id: 'merge-write', description: 'Wrote the env file while preserving existing keys', points: 4, validate: r => fileWriteCalls(r).some(c => c.path.includes('.env.local') && c.content.includes('SIGNOZ_API_KEY') && c.content.includes('GH_TOKEN')) },
      { id: 'no-inline-secret', description: 'Did not leak the token value through exec', points: 2, validate: r => !secretValueLeakedViaExec(r, 'GH_TOKEN') },
    ],
    maxScore: 8,
  },
  {
    id: 'orchestration-actionable-error',
    name: 'Tests an actionable local fix before escalating',
    category: 'orchestration-resilience',
    level: 2,
    input: 'The project file writer says the target directory is missing and suggests waiting for a remount. Verify the local workspace state and try the safe mkdir fix before asking a human to intervene. Report the command result.',
    validationCriteria: [
      { id: 'checked-state', description: 'Inspected the workspace or directory state', points: 2, validate: r => calls(r, 'exec').length > 0 || calls(r, 'read_file').length > 0 },
      { id: 'tried-fix', description: 'Tried an actionable mkdir or equivalent fix', points: 4, validate: r => calls(r, 'exec').some(c => /\bmkdir\b/.test(String(c.input.command ?? c.input.cmd ?? ''))) },
      { id: 'did-not-escalate-first', description: 'Did not immediately ask a human to act', points: 2, validate: r => !/ask a human|need you to open/i.test(r.responseText) || calls(r, 'exec').length > 0 },
    ],
    maxScore: 8,
  },
]

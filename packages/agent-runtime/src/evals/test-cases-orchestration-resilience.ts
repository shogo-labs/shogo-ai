// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { AgentEval, EvalResult } from './types'

const calls = (result: EvalResult, name: string) =>
  result.toolCalls.filter(call => call.name === name)

const sameInstanceRepolls = (result: EvalResult): boolean => {
  const resultCalls = calls(result, 'agent_result')
  if (resultCalls.length < 2) return false
  const ids = resultCalls.map(call => String(call.input.instance_id ?? ''))
  return ids[0] !== '' && ids.every(id => id === ids[0])
}

export const ORCHESTRATION_RESILIENCE_EVALS: AgentEval[] = [
  {
    id: 'orchestration-timeout-repoll',
    name: 'Repolls a running sub-agent instead of bypassing it',
    category: 'orchestration-resilience',
    level: 2,
    input: 'Spawn a background explore agent to inspect README.md. If agent_result says it is still running, keep polling the same instance until it completes. Do not inspect the file or do the sub-agent work yourself.',
    workspaceFiles: { 'README.md': '# Resilience fixture\n' },
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
      { id: 'merge-write', description: 'Wrote the env file while preserving existing keys', points: 4, validate: r => calls(r, 'write_file').some(c => String(c.input.path).includes('.env.local') && String(c.input.content).includes('SIGNOZ_API_KEY') && String(c.input.content).includes('GH_TOKEN')) },
      { id: 'no-inline-secret', description: 'Did not pass the token through exec', points: 2, validate: r => !calls(r, 'exec').some(c => JSON.stringify(c.input).includes('GH_TOKEN=')) },
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

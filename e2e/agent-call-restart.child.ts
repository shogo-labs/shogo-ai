// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stand-in for the API process that owns a tracked `project_call`, driven by
 * `agent-call-restart.test.ts`. It runs as its own OS process so the parent can
 * prove the record outlives its writer — the bug was per-process state.
 *
 * Usage: bun e2e/agent-call-restart.child.ts start|finish <projectId> <runId> <chatSessionId> [reply]
 */
const [phase, projectId, runId, chatSessionId, reply] = process.argv.slice(2)

if (!phase || !projectId || !runId || !chatSessionId) {
  console.error('[agent-call-restart.child] usage: start|finish <projectId> <runId> <chatSessionId> [reply]')
  process.exit(2)
}

const startedAt = Number(process.env.E2E_CALL_STARTED_AT ?? Date.now())
const store = await import('../apps/api/src/lib/agent-call-store')

if (phase === 'start') {
  await store.putAgentCall(projectId, {
    status: 'running',
    runId,
    sessionId: chatSessionId,
    chatSessionId,
    startedAt,
    updatedAt: startedAt,
  })
  await store.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt })
} else {
  await store.putAgentCall(projectId, {
    status: 'completed',
    runId,
    sessionId: chatSessionId,
    chatSessionId,
    reply: reply ?? 'PONG',
    startedAt,
    updatedAt: Date.now(),
  })
}

console.log(JSON.stringify({ phase, projectId, runId, pid: process.pid }))
process.exit(0)

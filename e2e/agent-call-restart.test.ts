// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E (SHO-39): a tracked `project_call` survives the process that started it.
 *
 * The record and the callee-chat link used to live in per-process Maps on
 * desktop and in Redis (with a Map fallback) in the cloud, so an API restart
 * mid-call lost the caller's result and the callee chat never healed.
 *
 * The other specs drive the store in-process and simulate the restart by
 * clearing a Map. This one uses a real process boundary: a child `bun` process
 * writes the running record and its chat link, exits, and the assertions here
 * read them back. If the store ever goes back to anything process-local, the
 * child's write is gone and these tests fail — the closest thing to the desktop
 * SIGKILL-respawn (or a cloud pod roll) that a test can do without booting the
 * whole app.
 *
 * Run: bun --no-env-file test e2e/agent-call-restart.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'child_process'
import { rmSync } from 'fs'
import { resolve } from 'path'
import { setupChannelsTestDb } from '../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const store = await import('../apps/api/src/lib/agent-call-store')

const REPO_ROOT = resolve(import.meta.dir, '..')
const CHILD = resolve(import.meta.dir, 'agent-call-restart.child.ts')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function childEnv(startedAt: number): NodeJS.ProcessEnv {
  // The helper already pointed both processes at its throwaway SQLite file.
  return { ...process.env, E2E_CALL_STARTED_AT: String(startedAt) }
}

/** Write and exit — the writer process is gone before the assertion runs. */
function writeInAnotherProcess(phase: 'start' | 'finish', projectId: string, runId: string, chatSessionId: string, startedAt: number, reply?: string) {
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', CHILD, phase, projectId, runId, chatSessionId, ...(reply ? [reply] : [])],
    { cwd: REPO_ROOT, env: childEnv(startedAt), encoding: 'utf8', timeout: 120_000 },
  )
  if (result.status !== 0) {
    throw new Error(`child ${phase} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
}

/** Same write, but from a process that finishes while the caller is polling. */
function writeLaterInAnotherProcess(phase: 'finish', projectId: string, runId: string, chatSessionId: string, startedAt: number, delayMs: number, reply?: string) {
  return new Promise<void>((done, fail) => {
    setTimeout(() => {
      const child = spawn(process.execPath, ['--no-env-file', CHILD, phase, projectId, runId, chatSessionId, ...(reply ? [reply] : [])], {
        cwd: REPO_ROOT,
        env: childEnv(startedAt),
        stdio: 'ignore',
      })
      child.on('error', fail)
      child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`child ${phase} exited ${code}`))))
    }, delayMs)
  })
}

describe('a tracked project_call across a real process restart', () => {
  test('the record and the callee-chat link outlive the process that wrote them', async () => {
    const projectId = 'proj-e2e-restart'
    const runId = 'run-e2e-restart'
    const chatSessionId = 'chat-e2e-restart'
    const startedAt = Date.now()

    writeInAnotherProcess('start', projectId, runId, chatSessionId, startedAt)

    // The writer is gone; this process has no memory of the call.
    expect(await store.getAgentCall(projectId, runId)).toMatchObject({
      status: 'running',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
    })
    expect(await store.getAgentCallSessionLink(chatSessionId)).toMatchObject({ projectId, runId })

    // A fresh writer (a restarted API finishing the call) closes it, and the
    // next reader — again a different process from the one that wrote it —
    // resolves the answer.
    writeInAnotherProcess('finish', projectId, runId, chatSessionId, startedAt, 'PONG')
    expect(await store.getAgentCall(projectId, runId)).toMatchObject({ status: 'completed', reply: 'PONG' })
  })

  test('the caller long-polls across the restart and settles when the callee finishes afterwards', async () => {
    const projectId = 'proj-e2e-restart'
    const runId = 'run-e2e-poll'
    const chatSessionId = 'chat-e2e-poll'
    const startedAt = Date.now()

    writeInAnotherProcess('start', projectId, runId, chatSessionId, startedAt)

    const finishing = writeLaterInAnotherProcess('finish', projectId, runId, chatSessionId, startedAt, 200, 'PONG')
    const settled = await store.waitForAgentCall(projectId, runId, 15_000, { pollIntervalMs: 50 })
    await finishing

    expect(settled).toMatchObject({ status: 'completed', reply: 'PONG' })
  })

  test('another project cannot read the call by runId, even across processes', async () => {
    const projectId = 'proj-e2e-restart'
    const runId = 'run-e2e-scoped'
    const chatSessionId = 'chat-e2e-scoped'

    writeInAnotherProcess('start', projectId, runId, chatSessionId, Date.now())

    expect(await store.getAgentCall('proj-e2e-other', runId)).toBeUndefined()
    expect(await store.getAgentCall(projectId, runId)).toMatchObject({ status: 'running' })
  })
})

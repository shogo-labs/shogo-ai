// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end run of the deploy CI gate against a fake GitHub API — this is the
 * regression the gate used to have: it read the merge_group run once, at t=0,
 * with status=completed, so a run that turned green a minute later was never
 * seen and the deploy timed out after 30 minutes.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '../ci/wait-for-ci.ts')
const SHA = 'c0ffee1234'

type Jobs = { jobs: { name: string; conclusion: string | null }[] }

const required = (conclusion: string | null): Jobs => ({
  jobs: [{ name: 'Prelude', conclusion: 'success' }, { name: 'Lint, Typecheck, Test', conclusion }],
})

let running: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  running?.stop(true)
  running = null
})

/** Serve the two endpoints the gate polls; `jobsFor` decides each run's state. */
function fakeApi(jobsFor: (runId: string, poll: number) => Jobs, runs: () => unknown) {
  let polls = 0
  running = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const runsMatch = url.pathname.match(/\/actions\/workflows\/ci\.yml\/runs$/)
      if (runsMatch) return Response.json(runs())
      const jobsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)
      if (jobsMatch) {
        polls += 1
        return Response.json(jobsFor(jobsMatch[1], polls))
      }
      return new Response(`unexpected ${url.pathname}`, { status: 404 })
    },
  })
  return running.port as number
}

async function runGate(base: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_API_URL: base,
      REPOSITORY: 'shogo-labs/shogo-ai',
      SHA,
      GH_TOKEN: 'test-token',
      GATE_POLL_MS: '20',
      GATE_TIMEOUT_MS: '10000',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

const queueRun = (status: string, conclusion: string | null) => ({
  id: 7,
  head_sha: SHA,
  event: 'merge_group',
  status,
  conclusion,
  run_number: 11,
})
const pushRun = (status: string, conclusion: string | null) => ({
  id: 9,
  head_sha: SHA,
  event: 'push',
  status,
  conclusion,
  run_number: 12,
})

describe('deploy CI gate against a fake API', () => {
  it('passes once the merge-queue run turns green, even though it was unfinished at t=0', async () => {
    let queueDone = false
    const port = fakeApi(
      (runId) => (runId === '7' && queueDone ? required('success') : required(null)),
      () => ({
        workflow_runs: [
          queueRun(queueDone ? 'completed' : 'in_progress', queueDone ? 'success' : null),
          // The push run for a queue-verified commit only warms caches and
          // never proves anything on its own — the old gate waited on it.
          pushRun('queued', null),
        ],
      }),
    )
    // Flip the merge-queue run to green after the gate's first poll.
    setTimeout(() => {
      queueDone = true
    }, 60)

    const { code, out } = await runGate(`http://127.0.0.1:${port}`)
    expect(out).toContain('merge-queue CI run 7')
    expect(code).toBe(0)
  })

  it('keeps polling and fails after the timeout when nothing ever reports', async () => {
    const port = fakeApi(
      () => required(null),
      () => ({ workflow_runs: [queueRun('in_progress', null), pushRun('in_progress', null)] }),
    )

    const { code, out } = await runGate(`http://127.0.0.1:${port}`, { GATE_TIMEOUT_MS: '200' })
    expect(out).toContain('Timed out waiting for CI to pass')
    expect(code).toBe(1)
  })

  it('fails fast when the merge-queue run reports the required job as failed', async () => {
    const port = fakeApi(
      () => required('failure'),
      () => ({ workflow_runs: [queueRun('completed', 'failure')] }),
    )

    const { code, out } = await runGate(`http://127.0.0.1:${port}`)
    expect(out).toContain('reports Lint, Typecheck, Test=failure')
    expect(code).toBe(1)
  })

  it('ignores runs for a different SHA', async () => {
    const port = fakeApi(
      () => required('success'),
      () => ({ workflow_runs: [{ ...queueRun('completed', 'success'), head_sha: 'someoneelse' }] }),
    )

    const { code, out } = await runGate(`http://127.0.0.1:${port}`, { GATE_TIMEOUT_MS: '200' })
    expect(out).toContain('Timed out waiting for CI to pass')
    expect(code).toBe(1)
  })
})

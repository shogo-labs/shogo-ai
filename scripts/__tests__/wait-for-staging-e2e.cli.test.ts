// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Executable-level e2e for the production deploy gate (SHO-135).
 *
 * `wait-for-staging-e2e.test.ts` proves `decide()`; this drives the real CLI
 * from `deploy.yml` — env parsing, both GitHub reads, the status's run lookup,
 * the `::error::` annotation, the exit code and the deadline — with `fetch`
 * replaced by a fixture so nothing touches GitHub. The stranded v2.3.8 payload
 * is reproduced exactly (run 39573508746, completed `failure`, no status).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '..', 'ci', 'wait-for-staging-e2e.ts')
const SHA = '125cf781caa3746dc8deb29342d2502f7b8b0866'

const STUB = `const fixture = JSON.parse(await Bun.file(process.env.QA135_FIXTURE).text())
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = (async (input) => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.replace(/^https:\\/\\/api\\.github\\.com\\//, '')
  if (path.includes('/commits/') && path.endsWith('/status')) return json({ statuses: fixture.statuses ?? [] })
  if (path.includes('/actions/workflows/deploy.yml/runs')) return json({ workflow_runs: fixture.runs ?? [] })
  const runMatch = path.match(/\\/actions\\/runs\\/(\\d+)/)
  if (runMatch) {
    const run = (fixture.runById ?? {})[runMatch[1]]
    return run ? json(run) : json({ message: 'Not Found' }, 404)
  }
  return json({ message: 'unexpected path ' + path }, 500)
})
`

type Fixture = {
  statuses?: unknown[]
  runs?: unknown[]
  runById?: Record<string, unknown>
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gate(fixture: Fixture, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sho135-cli-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'fetch-stub.ts'), STUB)
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture))
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, '--preload', join(dir, 'fetch-stub.ts'), SCRIPT], {
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      QA135_FIXTURE: join(dir, 'fixture.json'),
      REPOSITORY: 'shogo-labs/shogo-ai',
      SHA,
      GH_TOKEN: 'fixture-token',
      GATE_TIMEOUT_MS: '600000',
      GATE_POLL_MS: '100',
      ...env,
    },
  })
  return {
    exited: proc.exited.then((code) => ({ code, elapsedMs: Date.now() - started })),
    stdout: () => new Response(proc.stdout).text(),
    stderr: () => new Response(proc.stderr).text(),
  }
}

const mainRun = (over: Record<string, unknown> = {}) => ({
  id: 39573508746,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/shogo-labs/shogo-ai/actions/runs/39573508746',
  ...over,
})

describe('wait-for-staging-e2e.ts CLI', () => {
  it(
    'fails the stranded v2.3.8 release in seconds, naming run 39573508746 and the rerun that recovers it',
    async () => {
      const gateRun = gate({ statuses: [], runs: [mainRun()] })
      const { code, elapsedMs } = await gateRun.exited
      const out = await gateRun.stdout()

      expect(code).toBe(1)
      // The whole point: a dead staging run must not consume the 110-minute deadline.
      expect(elapsedMs).toBeLessThan(20_000)
      expect(out).toContain('::error::staging deploy run 39573508746 finished (failure) without publishing')
      expect(out).toContain('gh run rerun 39573508746 --failed')
      expect(out).toContain("then re-run this release's tag run")
    },
    60_000,
  )

  it(
    'fails a pending status whose run already finished instead of waiting out the timeout',
    async () => {
      const deadRun = mainRun({ id: 777, conclusion: 'failure' })
      const gateRun = gate(
        {
          statuses: [
            {
              context: 'e2e/staging-critical',
              state: 'pending',
              target_url: 'https://github.com/shogo-labs/shogo-ai/actions/runs/777',
            },
          ],
          runs: [deadRun],
          runById: { '777': deadRun },
        },
        { GATE_TIMEOUT_MS: '600000' },
      )
      const { code, elapsedMs } = await gateRun.exited
      const out = await gateRun.stdout()

      expect(code).toBe(1)
      expect(elapsedMs).toBeLessThan(20_000)
      expect(out).toContain('is still pending, but the run that set it (777) already finished (failure)')
      expect(out).toContain('gh run rerun 777 --failed')
      expect(out).not.toContain('Timed out waiting')
    },
    60_000,
  )

  it('passes as soon as the status is green', async () => {
    const gateRun = gate({ statuses: [{ context: 'e2e/staging-critical', state: 'success' }], runs: [mainRun()] })
    const { code } = await gateRun.exited
    const out = await gateRun.stdout()

    expect(code).toBe(0)
    expect(out).toContain(`e2e/staging-critical is green for ${SHA}.`)
  }, 60_000)

  it('keeps waiting — not failing — while the staging rollout is still running', async () => {
    const gateRun = gate({ statuses: [], runs: [mainRun({ id: 55, status: 'in_progress', conclusion: null })] }, {
      GATE_TIMEOUT_MS: '1200',
      GATE_POLL_MS: '200',
    })
    const { code } = await gateRun.exited
    const out = await gateRun.stdout()

    expect(code).toBe(1)
    expect(out).toContain('staging deploy run 55 for this commit is in_progress')
    expect(out).toContain('Timed out waiting for e2e/staging-critical')
    expect(out).not.toContain('gh run rerun')
  }, 60_000)
})

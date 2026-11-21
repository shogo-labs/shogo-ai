// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 9 — a project's preview, served from the computer that hosts
 * the workspace, opened through the cloud.
 *
 * The preview is a port tunnel: the client asks `/api/preview/:projectId/render`
 * and the API resolves the project's runtime and streams whatever that runtime
 * serves. On a hosted workspace the runtime is the paired desktop, so a cloud
 * answer of "no runtime driver configured" (501) is the failure that leaves the
 * Preview tab empty with nothing in the console — and a 500 or a `not_running`
 * body is the same emptiness with a different code.
 *
 * The second case is the one a person actually does: the app is built (the
 * runtime self-serves `dist/index.html`, see `preview-url-context.ts`), and the
 * page that comes back through the tunnel is the app's, not the cloud's. The
 * file is written on the side that owns the compute — the desktop, for a hosted
 * workspace — so a pass means the content crossed the proxy in both directions.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`. Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  startRemoteWorkspace,
  uniq,
  waitFor,
  type RemoteWorkspace,
  type Side,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let llm: FakeLlmServer
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

/** The preview a person opens: the render proxy, not the URL-detection endpoint. */
const renderPath = (projectId: string) => `/api/preview/${encodeURIComponent(projectId)}/render/`

const previewPath = (t: Target, projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/preview`

/** Where the project's files live: the desktop owns the compute for a hosted workspace. */
function computeOf(name: (typeof TARGET_NAMES)[number], t: Target): Side {
  return name === 'hosted' && t.peer ? t.peer : t
}

/**
 * Writes a file into the workspace the runtime serves (its own file API, the
 * one the agent uses). The project-files route is not usable here: it refuses
 * `dist` by design (`EXCLUDED_DIRS` in `routes/files.ts`), which is exactly the
 * directory a built app lives in.
 */
async function writeWorkspaceFile(side: Side, path: string, content: string): Promise<number> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    {
      method: 'PUT',
      headers: { cookie: side.cookie, origin: side.base, 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  )
  return res.status
}

async function readWorkspaceFile(side: Side, path: string): Promise<string> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { headers: { cookie: side.cookie, origin: side.base } },
  )
  return res.status === 200 ? String((await res.json().catch(() => ({}))).content ?? '') : `HTTP ${res.status}`
}

describeIfInfra('remote workspace · project preview', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('the preview URL resolves to a runtime instead of a cloud refusal', async () => {
        const t = target(name)
        const projectId = t.seed.projectIds[0]
        const res = await fetch(`${t.base}${previewPath(t, projectId)}`, {
          headers: { cookie: t.cookie, origin: t.base },
          redirect: 'manual',
        })
        const body = await res.text().catch(() => '')

        // Whatever the runtime says — 200 for a live preview, 204/404 when
        // nothing is built — the request has to have reached one.
        expect(
          res.status,
          `preview answered ${res.status}: ${body.slice(0, 400)}`,
        ).not.toBe(501)
        expect(body, `preview answered a cloud refusal: ${body.slice(0, 400)}`).not.toContain(
          'driver not configured',
        )
        expect(res.status, `preview answered ${res.status}: ${body.slice(0, 400)}`).toBeLessThan(600)
      }, 120_000)

      // Measured on this harness (18:03): the file is written where the runtime
      // serves it and reads back correctly, and the preview never serves it —
      // `404 {"error":{"code":"not_supported_locally"}}` from the cloud for the
      // cloud and hosted targets (the proxy refuses before reaching a runtime),
      // and a plain `404 Not Found` on the desktop, where the proxy does reach a
      // runtime. So a built app does not load through the preview on any of the
      // three today. `test.failing` keeps the requirement asserted and flips
      // when the proxy serves a built app.
      test.failing(
        'a built app loads through the cloud preview URL, served by the compute side [proxy answers not_supported_locally / 404]',
        async () => {
        const t = target(name)
        const compute = computeOf(name, t)
        const projectId = t.seed.projectIds[0]
        const badge = uniq('preview')

        // The runtime self-serves a built `dist/index.html` under the workspace
        // root (`gateway.ts` ~6907). Write one where the compute side's runtime
        // will find it, so the cloud has to read it through the proxy.
        const written = await writeWorkspaceFile(
          compute,
          'dist/index.html',
          `<!doctype html><html><head><title>${badge}</title></head><body><h1 id="marker">${badge}</h1></body></html>`,
        )
        expect(written, 'writing dist/index.html into the workspace runtime').toBeLessThan(300)

        // The runtime notices the file and starts serving it; then the page has
        // to come back through this side's preview proxy.
        let last = ''
        let lastStatus = 0
        await waitFor(
          'the built app through the preview proxy',
          async () => {
            const res = await fetch(`${t.base}${renderPath(projectId)}`, {
              headers: { cookie: t.cookie, origin: t.base },
              redirect: 'manual',
            })
            lastStatus = res.status
            last = await res.text().catch(() => '')
            return last.includes(badge)
          },
          60_000,
          2_000,
        ).catch((err: Error) => {
          throw new Error(
            `${err.message}\n  last preview answer: ${lastStatus} ${last.slice(0, 300)}` +
              `\n  the app was built on the ${name === 'hosted' ? 'desktop' : name} side`,
          )
        })

        expect(last, 'the page served through the proxy is the app that was built').toContain(badge)
        },
        240_000,
      )
    })
  }

  // The stored file is read back from the same side that wrote it, so a later
  // suite cannot mistake a stale copy for a live one.
  test('the built index.html is readable on the side that owns the compute', async () => {
    const t = target('hosted')
    const compute = computeOf('hosted', t)
    const body = await readWorkspaceFile(compute, 'dist/index.html')
    expect(body, `read back: ${body.slice(0, 200)}`).toContain('<html>')
    void llm
  }, 120_000)
})

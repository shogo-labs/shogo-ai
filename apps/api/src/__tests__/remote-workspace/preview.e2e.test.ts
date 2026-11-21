// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 9 — a project's preview, served from the computer that hosts
 * the workspace, opened through the cloud.
 *
 * The preview is a port tunnel: the cloud resolves the project's runtime and
 * fetches whatever that runtime serves. On a hosted workspace the runtime is the
 * paired desktop, so a cloud answer of "no runtime driver configured" (501) is
 * the failure that leaves the Preview tab empty with nothing in the console.
 *
 * The second case is the one a person actually does: the app is built (a
 * workspace runtime self-serves `<workspace>/<projectId>/dist/index.html` under
 * `/p/<projectId>/`, see `server.ts` `app.get('/p/:projectId/*')`), and the page
 * that comes back through the tunnel is the app's, not the cloud's. The file is
 * written on the side that owns the compute — the desktop, for a hosted
 * workspace — and read back through the **cloud**, so a pass means the content
 * crossed the proxy in both directions.
 *
 * What this file cannot exercise is `/api/preview/:projectId/render`, the
 * subdomain Worker's render proxy: it is gated on `isKubernetes()`
 * (`apps/api/src/server.ts:2589`) and answers `not_supported_locally` in every
 * non-k8s process before it ever resolves a runtime, so in this harness (real
 * API processes on a laptop) it measures the gate, not the product. Its
 * host-tunnel branch is the same `resolveProjectPodUrl` + `lib/host-tunnel` path
 * the tunnel route below crosses, which is why the tunnel is asserted here and
 * the render proxy is left to a k8s-substrate harness.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`. Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  startRemoteWorkspace,
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

/** Where a workspace runtime serves one project's built app (agent-runtime server.ts). */
const projectServePath = (projectId: string) => `/p/${encodeURIComponent(projectId)}/`

const previewPath = (t: Target, projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/preview`

/** Where the project's files live: the desktop owns the compute for a hosted workspace. */
function computeOf(name: (typeof TARGET_NAMES)[number], t: Target): Side {
  return name === 'hosted' && t.peer ? t.peer : t
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

      // The requirement, end to end: the app is built on the computer that hosts
      // the workspace, and the page the cloud serves is that build. A workspace
      // runtime serves `<workspace>/<projectId>/dist` under `/p/<projectId>/`
      // (`packages/agent-runtime/src/server.ts`), and the cloud reaches a
      // project's runtime through the agent proxy — the host tunnel, for a
      // hosted workspace. So: read the build the compute side holds, then fetch
      // the page through the cloud and require the same hashed bundle. Matching
      // hashes is what makes it the machine's build and not a stray one: two
      // builds of the same app never agree on an asset hash.
      //
      // The retry loop is for the machine's build being *in flight* (a 503
      // "Building preview…" interstitial), not for state to propagate — a pass
      // is a page that came back over the proxy with the compute side's bundle.
      test('the page the cloud serves through the project tunnel is the compute side’s build', async () => {
        const t = target(name)
        const compute = computeOf(name, t)
        const projectId = t.seed.projectIds[0]
        const pagePath = `/api/projects/${encodeURIComponent(projectId)}/agent-proxy${projectServePath(projectId)}`

        let served = ''
        let status = 0
        await waitFor(
          'the project’s built page through the cloud',
          async () => {
            const res = await fetch(`${t.base}${pagePath}`, {
              headers: { cookie: t.cookie, origin: t.base },
              redirect: 'manual',
            })
            status = res.status
            served = await res.text().catch(() => '')
            return status === 200 && served.includes('<html')
          },
          180_000,
          2_000,
        ).catch((err: Error) => {
          throw new Error(
            `${err.message}\n  last answer from the cloud: ${status} ${served.slice(0, 300)}` +
              `\n  the app is built on the ${name === 'hosted' ? 'desktop' : name} side`,
          )
        })

        // The build the compute side holds…
        const onDisk = await readWorkspaceFile(compute, `${projectId}/dist/index.html`)
        expect(onDisk, `the compute side's dist/index.html: ${onDisk.slice(0, 200)}`).toContain('/assets/')

        // …is the page the cloud just served: one hashed bundle, not two builds.
        const bundle = (html: string) => (html.match(/\/p\/[^\s"']*\/assets\/[^\s"']+\.js/) ?? [''])[0]
        expect(bundle(onDisk), `the compute side's build: ${onDisk.slice(0, 300)}`).not.toBe('')
        expect(bundle(served), `the page the cloud served: ${served.slice(0, 300)}`).toBe(bundle(onDisk))
      }, 240_000)
    })
  }

  // The stored file is read back from the same side that wrote it, so a later
  // suite cannot mistake a stale copy for a live one.
  test('the built index.html is readable on the side that owns the compute', async () => {
    const t = target('hosted')
    const compute = computeOf('hosted', t)
    const body = await readWorkspaceFile(compute, `${t.seed.projectIds[0]}/dist/index.html`)
    expect(body, `read back: ${body.slice(0, 200)}`).toContain('<html')
    void llm
  }, 120_000)
})

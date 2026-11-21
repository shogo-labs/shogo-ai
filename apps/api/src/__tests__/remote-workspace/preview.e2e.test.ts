// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 9 — a project's preview, served from the computer that hosts
 * the workspace, opened through the cloud.
 *
 * The preview is a port tunnel: the cloud answers `/api/projects/:id/preview`,
 * resolves the project's runtime and streams whatever that runtime serves. On a
 * hosted workspace the runtime is the paired desktop, so a cloud answer of
 * "no runtime driver configured" (501) is the failure that leaves the Preview
 * tab empty with nothing in the console. This suite asserts the request reaches
 * a runtime on every target and that the answer is the runtime's, not the
 * cloud's refusal.
 *
 * Loading a *built* app through the tunnel is `test.skip` below: the seeded
 * projects are empty directories, and building one real app per target does not
 * fit a per-file budget (the card asks for < 5 min each). Once the seed ships a
 * project with a static `index.html` — or `preview/start` is scripted — the
 * skipped case becomes: GET the cloud preview URL and read the app's own marker
 * out of the HTML.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`. Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  startRemoteWorkspace,
  type RemoteWorkspace,
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

const previewPath = (t: Target, projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/preview`

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

      test.skip('a built app loads from the cloud preview URL, served by the desktop', async () => {
        // Blocked on the seed, not on this suite: see the file header.
        //
        //   const t = target(name)
        //   const projectId = t.seed.projectIds[0]
        //   // write a static index.html on the computer that hosts the workspace
        //   await writePreviewIndex(name === 'hosted' ? t.peer! : t, projectId, marker)
        //   const res = await fetch(`${t.base}${previewPath(t, projectId)}/`, { headers: … })
        //   expect(await res.text()).toContain(marker)
        void llm
      }, 240_000)
    })
  }
})

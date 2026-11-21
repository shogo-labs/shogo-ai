// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 8 — schedules and triggers in a remote workspace.
 *
 * A schedule belongs to the workspace, and its run belongs to the workspace's
 * compute. Created from the cloud it has to reach the computer that will run it,
 * a toggle has to stick on both sides, and a run started from the cloud has to
 * happen on that computer.
 *
 * `run now` needs a model, so it runs on `TURN_TARGETS` (see harness.ts); the
 * rest runs on all three.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import { marker } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  TURN_TARGETS,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  waitFor,
  waitForSync,
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

const base = (side: Side) => `/api/workspaces/${encodeURIComponent(side.workspaceId)}`

async function schedules(side: Side): Promise<any[]> {
  const res = await read(side, `${base(side)}/schedules`)
  return res.data?.schedules ?? res.data?.items ?? []
}

describeIfInfra('remote workspace · schedules and triggers', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('a schedule created here is listed, and a toggle sticks', async () => {
        const t = target(name)
        const scheduleName = uniq('digest')
        const created = await send(t.api, 'POST', `${base(t)}/schedules`, {
          name: scheduleName,
          prompt: 'Summarise the day',
          cronExpression: '0 9 * * *',
          enabled: false,
        })
        expect(created.status, JSON.stringify(created.data)).toBe(201)
        const scheduleId = created.data?.schedule?.id
        expect(scheduleId).toBeTruthy()
        expect((await schedules(t)).map((s) => s.name)).toContain(scheduleName)

        const enabled = await send(t.api, 'PATCH', `${base(t)}/schedules/${encodeURIComponent(scheduleId)}`, { enabled: true })
        expect(enabled.status, JSON.stringify(enabled.data)).toBeLessThan(300)
        await waitFor(
          'the schedule to read back enabled',
          async () => (await schedules(t)).find((s) => s.id === scheduleId)?.enabled === true,
          30_000,
          500,
        )
      }, 120_000)

      test('a trigger created here is listed and can be disabled', async () => {
        const t = target(name)
        const triggerName = uniq('welcome')
        const created = await send(t.api, 'POST', `${base(t)}/triggers`, {
          name: triggerName,
          eventType: 'member.joined',
          prompt: 'Welcome them',
          target: 'agent',
        })
        expect(created.status, JSON.stringify(created.data)).toBeLessThan(300)
        const triggerId = created.data?.trigger?.id
        expect(triggerId).toBeTruthy()

        const listed = await read(t, `${base(t)}/triggers`)
        expect(JSON.stringify(listed.data)).toContain(triggerName)

        const disabled = await send(t.api, 'PATCH', `${base(t)}/triggers/${encodeURIComponent(triggerId)}`, { enabled: false })
        expect(disabled.status, JSON.stringify(disabled.data)).toBeLessThan(300)
        const after = await read(t, `${base(t)}/triggers`)
        const row = (after.data?.triggers ?? after.data?.items ?? []).find((x: any) => x.id === triggerId)
        expect(row?.enabled).toBe(false)
      }, 120_000)

      if (TURN_TARGETS.includes(name)) {
        test('run now makes the workspace’s own compute run the schedule', async () => {
          const t = target(name)
          const tag = `s${name.slice(0, 2)}${Date.now() % 100_000}`
          const created = await send(t.api, 'POST', `${base(t)}/schedules`, {
            name: uniq('run now'),
            prompt: `Summarise ${marker('long', tag, 4, { ms: 5 })}`,
            cronExpression: '0 9 * * *',
            // Runs are refused for a disabled schedule (`schedule_disabled`), and
            // a 9am cron will not fire inside this test.
            enabled: true,
          })
          expect(created.status, JSON.stringify(created.data)).toBe(201)
          const scheduleId = created.data.schedule.id

          const run = await send(t.api, 'POST', `${base(t)}/schedules/${encodeURIComponent(scheduleId)}/run`, {})
          expect(run.status, JSON.stringify(run.data)).toBe(202)

          // The dispatcher's next tick claims it and the turn runs where the
          // workspace lives: the scripted model there sees the prompt.
          await waitFor('the schedule turn on the workspace compute', async () => llm.requestsFor(tag).length > 0, 240_000, 2_000)
        }, 300_000)
      }
    })
  }

  test('hosted · a schedule created from the cloud reaches the desktop', async () => {
    const t = target('hosted')
    const peer = t.peer!
    const scheduleName = uniq('synced digest')
    const created = await send(t.api, 'POST', `${base(t)}/schedules`, {
      name: scheduleName,
      prompt: 'Summarise the day',
      cronExpression: '0 9 * * *',
      enabled: false,
    })
    expect(created.status, JSON.stringify(created.data)).toBe(201)
    await waitForSync(ws.machine, 'the schedule on the desktop', async () =>
      (await schedules(peer)).some((s) => s.name === scheduleName), 120_000, 1_000)
  }, 180_000)
})

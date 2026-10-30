// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-257 — the staging half of the machine-VM parity suite.
 *
 * `apps/api/src/__tests__/machine-vm-parity.acceptance.test.ts` proves it on a
 * cloud process it starts itself; this runs the same seed and the same surface
 * table against a deployed cloud. An isolated local API on *this* machine (own
 * data dir and database, so the Mac's own pairing is untouched) is paired to a
 * throwaway account through `cli/login`, and every surface the studio reads is
 * compared: the machine's workspace seen from the cloud vs. the desktop's own
 * answer. A cloud workspace on the same account is seeded identically, as the
 * VM baseline.
 *
 * Opt-in, because it pairs this computer to the target cloud:
 *   E2E_STAGING_MACHINE=1 STAGING_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts machine-vm-parity --project chromium
 *
 * The target serves `main`. Measured on staging, 2026-10-30, before #1803 and
 * SHO-257 were deployed: writes went both ways, but from the cloud the
 * machine's workspace chats were empty, their messages answered 404 "Chat
 * session not found" (the copy was read as the owner's cloud account, which
 * wrote none of them), and people-and-agents listed the owner twice. The
 * local suite on the fixed branch passes all three, so this is red there until
 * both are deployed.
 */
import { expect, test } from "@playwright/test"
import { httpClient, machineViewClient, read, sessionUserId, waitFor } from "../../apps/api/src/__tests__/helpers/machine-vm-clients"
import { seedWorkspace, SURFACES, type Seeded } from "../../apps/api/src/__tests__/helpers/machine-vm-surfaces"
import { pairMachine, type PairedMachine } from "./machine-pairing"

const TARGET = (process.env.STAGING_URL || process.env.E2E_TARGET_URL || "https://studio.staging.shogo.ai").replace(/\/$/, "")

test.skip(
  process.env.E2E_STAGING_MACHINE !== "1",
  "pairs this machine to the target cloud; set E2E_STAGING_MACHINE=1 to run it",
)

test.describe("SHO-257 · a paired machine's workspace is a workspace VM, on a deployed cloud", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(600_000)

  let machine: PairedMachine
  let seeds: { cloud: Seeded; machine: Seeded }
  let cloudUserId: string
  let localUserId: string

  const clients = () => ({
    cloud: httpClient(TARGET, machine.cookies),
    desktop: httpClient(machine.localApiBase, machine.localCookies),
    view: machineViewClient({ base: TARGET, cookie: machine.cookies, userId: cloudUserId }, machine.machineId, machine.machineWorkspaceId),
  })

  test.beforeAll(async () => {
    test.setTimeout(600_000)
    machine = await pairMachine(TARGET, { instanceName: `sho257-${Math.random().toString(36).slice(2, 8)}` })
    cloudUserId = await sessionUserId(TARGET, machine.cookies)
    localUserId = await sessionUserId(machine.localApiBase, machine.localCookies)
    const { cloud, desktop } = clients()
    seeds = {
      cloud: await seedWorkspace(cloud, machine.cloudWorkspaceId, "Cloudy"),
      machine: await seedWorkspace(desktop, machine.machineWorkspaceId, "Machy"),
    }
  })

  test.afterAll(async () => {
    await machine?.stop()
  })

  test("a message sent from the cloud lands on the machine, and the machine's reaches the cloud", async () => {
    const { desktop, view } = clients()
    const conv = `/api/conversations/${encodeURIComponent(seeds.machine.channelId)}/messages`
    const texts = async (client: ReturnType<typeof httpClient>) =>
      ((await read(client, `${conv}?limit=100`)).data?.messages ?? []).map((m: { text: string }) => m.text)

    const fromCloud = `from the cloud ${Date.now()}`
    await view.post(conv, { text: fromCloud })
    expect(await texts(desktop)).toContain(fromCloud)

    const fromMachine = `from the machine ${Date.now()}`
    await desktop.post(conv, { text: fromMachine })
    await waitFor("the machine's message from the cloud", async () => (await texts(view)).includes(fromMachine), 120_000, 2_000)
  })

  // One test, a soft-checked step per surface: a deployed cloud that is behind
  // reports every surface it gets wrong, not just the first one.
  test("every surface the studio reads, from the cloud, matches the desktop", async () => {
    const { cloud, desktop, view } = clients()
    for (const surface of SURFACES) {
      await test.step(surface.name, async () => {
        const base = await read(cloud, surface.path(seeds.cloud))
        expect.soft(base.status, `${surface.name} cloud baseline: ${base.error}`).toBeLessThan(300)

        const local = await read(desktop, surface.path(seeds.machine))
        expect(local.status, `${surface.name} desktop: ${local.error}`).toBeLessThan(300)
        const desktopView = surface.view(local.data, seeds.machine)
        surface.shows(desktopView, seeds.machine)
        const expected = JSON.stringify(desktopView)?.split(localUserId).join(cloudUserId)

        let last: { status: number; data: any } | null = null
        const matched = await waitFor(
          `${surface.name} from the cloud to match the desktop`,
          async () => {
            last = await read(view, surface.path(seeds.machine))
            return last.status < 300 && JSON.stringify(surface.view(last.data, seeds.machine)) === expected
          },
          90_000,
          2_000,
        ).then(() => true, () => false)
        const seen = last && (last as any).status < 300 ? surface.view((last as any).data, seeds.machine) : (last as any)?.data
        expect
          .soft(
            matched,
            `${surface.name}: from the cloud (${(last as any)?.status}) ${JSON.stringify(seen)?.slice(0, 400)} ≠ desktop ${expected?.slice(0, 400)}`,
          )
          .toBe(true)
      })
    }
  })
})

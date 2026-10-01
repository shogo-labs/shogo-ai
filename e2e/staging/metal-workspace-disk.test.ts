// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import {
  bootstrapApiBase,
  createProjectAndWait,
  makeTestUser,
  runtimeFaultViaApi,
  signUpAndOnboard,
  suspendRuntimeViaApi,
  type TestUser,
} from "./helpers"

/**
 * Metal workspace drive E2E: a project's workspace lives on its own per-VM
 * drive rather than in the few GiB the golden rootfs leaves free (the
 * "disk is full, 14 GB used of 14 GB" reports), and that drive survives a
 * wake from the durable store.
 *
 *   1. /app/workspace is a separate mount with well over the rootfs's headroom,
 *      and writing more than the rootfs could ever hold succeeds.
 *   2. Suspend, drop the host's LOCAL snapshot (`evict-local`, what a wake on
 *      another host sees), reopen: files written before the suspend are back.
 *
 * Commands run in the project's real VM through the same terminal PTY the web
 * UI uses. The fault needs `SHOGO_E2E_BOOTSTRAP_SECRET` here and
 * `METAL_E2E_FAULTS=1` + `METAL_WORKSPACE_DRIVE_MIB` on the metal hosts; the
 * suite skips when the project is not on a host with the drive.
 *
 * Run: E2E_TARGET_URL=... SHOGO_E2E_BOOTSTRAP_SECRET=... \
 *   npx playwright test --config e2e/playwright.config.ts metal-workspace-disk
 */

const TEST_USER = makeTestUser("MetalWorkspaceDisk")
const MIN_WORKSPACE_BYTES = 15 * 1024 ** 3
const BIG_MIB = 6144

async function ensureAuthenticated(page: Page, user: TestUser): Promise<void> {
  await page.goto("/")
  const home = page.getByText("What are we building", { exact: false }).first()
  const signUpTab = page.getByRole("tab", { name: "Sign Up" })
  await Promise.race([
    home.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
    signUpTab.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {}),
  ])
  if (await home.isVisible().catch(() => false)) return
  await signUpAndOnboard(page, user)
}

/**
 * Run `cmd` in the project's runtime through a terminal PTY session and return
 * its output and exit status. Frames: client DATA = 0x01 + bytes; server DATA =
 * 0x81 + 4-byte seq + bytes (packages/pty-core/src/pty-protocol.ts).
 */
async function runtimeExec(
  page: Page,
  projectId: string,
  cmd: string,
  timeoutMs = 180_000,
): Promise<{ out: string; code: number }> {
  const base = bootstrapApiBase()
  const deadline = Date.now() + 240_000
  let session: { id: string } | null = null
  // The runtime may still be waking right after an open; retry the create.
  while (!session) {
    const res = await page.request
      .post(`${base}/api/projects/${projectId}/terminal/sessions`, {
        headers: { Origin: base, "content-type": "application/json" },
        data: { cols: 200, rows: 50 },
        timeout: 120_000,
      })
      .catch(() => null)
    if (res?.ok()) session = (await res.json()) as { id: string }
    else if (Date.now() > deadline) {
      throw new Error(`terminal session create failed (${res?.status() ?? "timeout"}): ${(await res?.text()) ?? ""}`)
    } else await page.waitForTimeout(3_000)
  }
  try {
    const wsUrl = `${base.replace(/^http/, "ws")}/api/projects/${projectId}/terminal/sessions/${session.id}/ws`
    return await page.evaluate(
      ({ wsUrl, cmd, timeoutMs }) =>
        new Promise<{ out: string; code: number }>((resolve, reject) => {
          const nonce = Math.random().toString(36).slice(2, 10)
          const endRe = new RegExp(`__END_${nonce}_(\\d+)__`)
          let buf = ""
          const ws = new WebSocket(wsUrl)
          ws.binaryType = "arraybuffer"
          const timer = setTimeout(() => {
            ws.close()
            reject(new Error(`runtime command timed out: ${cmd}\n${buf.slice(-2000)}`))
          }, timeoutMs)
          ws.onopen = () => {
            const line = `stty -echo; { ${cmd} ; } 2>&1; echo "__END_${nonce}_$?__"\r`
            const bytes = new TextEncoder().encode(line)
            const frame = new Uint8Array(1 + bytes.length)
            frame[0] = 0x01
            frame.set(bytes, 1)
            ws.send(frame)
          }
          ws.onmessage = (ev) => {
            const data = new Uint8Array(ev.data as ArrayBuffer)
            if (data[0] !== 0x81 || data.length < 5) return
            buf += new TextDecoder().decode(data.subarray(5))
            const m = endRe.exec(buf)
            if (!m) return
            clearTimeout(timer)
            ws.close()
            const start = buf.lastIndexOf("stty -echo;")
            const body = buf.slice(0, m.index)
            const out = (start >= 0 ? body.slice(body.indexOf("\n", start) + 1) : body).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trim()
            resolve({ out, code: parseInt(m[1], 10) })
          }
          ws.onerror = () => {
            clearTimeout(timer)
            reject(new Error(`terminal websocket error running: ${cmd}`))
          }
        }),
      { wsUrl, cmd, timeoutMs },
    )
  } finally {
    await page.request
      .delete(`${base}/api/projects/${projectId}/terminal/sessions/${session.id}`, { headers: { Origin: base } })
      .catch(() => {})
  }
}

async function mustExec(page: Page, projectId: string, cmd: string, timeoutMs?: number): Promise<string> {
  const r = await runtimeExec(page, projectId, cmd, timeoutMs)
  expect(r.code, `\`${cmd}\` failed:\n${r.out}`).toBe(0)
  return r.out
}

/** `df -B1 --output=source,size,avail <path>` in the runtime. */
async function df(page: Page, projectId: string, path: string) {
  const out = await mustExec(page, projectId, `df -B1 --output=source,size,avail ${path} | tail -1`)
  const [source, size, avail] = out.trim().split(/\s+/)
  return { source, size: Number(size), avail: Number(avail) }
}

test.describe("Metal workspace drive", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let projectId = ""
  const marker = `wsdrive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await ensureAuthenticated(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test("the workspace is its own disk with room to grow", async () => {
    test.setTimeout(600_000)
    await createProjectAndWait(
      page,
      "Create the simplest possible starter app: a single page that shows the word Hello. No extra pages, components, features, or backend.",
    )
    projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(projectId, `expected a /projects/<id> URL, got ${page.url()}`).not.toBe("")

    const mounted = await runtimeExec(page, projectId, "findmnt -no SOURCE /app/workspace")
    test.skip(mounted.code !== 0, "runtime is not on a metal host with the workspace drive enabled")

    const ws = await df(page, projectId, "/app/workspace")
    const root = await df(page, projectId, "/")
    expect(ws.source, "workspace must not share the root device").not.toBe(root.source)
    expect(ws.size).toBeGreaterThan(MIN_WORKSPACE_BYTES)

    // More than the rootfs's entire free space: this is what used to hit ENOSPC.
    const bigMiB = Math.max(BIG_MIB, Math.ceil(root.avail / 1024 ** 2) + 1024)
    await mustExec(
      page,
      projectId,
      `dd if=/dev/zero of=/app/workspace/.wsdrive-e2e.bin bs=4M count=${bigMiB / 4} conv=fsync status=none && ` +
        `rm -f /app/workspace/.wsdrive-e2e.bin`,
      600_000,
    )
    await mustExec(page, projectId, `echo ${marker} > /app/workspace/.wsdrive-e2e-marker && sync`)
  })

  test("the drive comes back from the durable store", async () => {
    test.setTimeout(600_000)
    test.skip(!process.env.SHOGO_E2E_BOOTSTRAP_SECRET, "needs SHOGO_E2E_BOOTSTRAP_SECRET for the fault backdoor")
    // An open project page keeps the runtime warm and would wake it again
    // before the fault lands.
    await page.goto("about:blank")
    expect(await suspendRuntimeViaApi(page, projectId), "runtime must really suspend").toBe(true)
    const r = await runtimeFaultViaApi(page, projectId, "evict-local")
    test.skip(!r, "runtime faults unavailable (host needs METAL_E2E_FAULTS=1)")
    expect(r!.ok, JSON.stringify(r!.body)).toBe(true)

    await page.goto(`/projects/${projectId}`)
    const out = await mustExec(page, projectId, "cat /app/workspace/.wsdrive-e2e-marker; findmnt -no SOURCE /app/workspace")
    expect(out).toContain(marker)
  })
})

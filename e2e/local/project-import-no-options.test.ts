// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-211 — "importing a project should not have any options it should just
 * import".
 *
 * Driven through the real UI against the real local API. **+ New → Import
 * .shogo…** has to open the OS file picker from the press handler itself (no
 * options modal in front of it), start the import the moment a file comes
 * back, and land on the imported project — with nothing clicked after the file
 * choice. The archives are real exports of a real project (with a chat in it),
 * so this also proves the flow keeps importing chats now that the toggle is
 * gone.
 *
 * The three cases that still need a screen are covered too: an archive whose
 * import reports a warning keeps its summary (so the warning is not lost), a
 * cancelled picker opens nothing, and a ZipCrypto-encrypted export asks only
 * for its password — which is also the one thing that has to agree with the
 * export byte-for-byte, since the client sniffs the same header the server
 * does.
 *
 * Needs the local stack:
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts project-import-no-options
 */
import { mkdirSync, writeFileSync } from "fs"
import { resolve } from "path"
import { strToU8, unzipSync, zipSync } from "fflate"
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, api, signIn, teamWorkspaceId } from "./team-nav-seed"

const ARCHIVE_DIR = resolve(__dirname, "../../test-results/sho-211-import")

async function apiJson(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(`${LOCAL_API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    data: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status(), json }
}

/**
 * Exports a project and writes the bytes to disk. An unencrypted export seeds
 * a placeholder `MEMORY.md` when the source workspace never wrote one, and the
 * importer warns about that placeholder — so `memory` lets a test say "this is
 * a project an agent has actually used" and get a warning-free archive.
 */
async function exportTo(
  page: Page,
  projectId: string,
  name: string,
  opts: { password?: string; memory?: string } = {},
) {
  const res = await page.request.post(`${LOCAL_API_BASE}/api/projects/${projectId}/export`, {
    data: JSON.stringify({ includeChats: true, ...(opts.password ? { password: opts.password } : {}) }),
    headers: { "content-type": "application/json" },
  })
  expect(res.status(), await res.text().catch(() => "")).toBe(200)
  let bytes = new Uint8Array(await res.body())
  if (opts.memory) {
    const entries = unzipSync(bytes)
    entries["workspace/MEMORY.md"] = strToU8(opts.memory)
    bytes = zipSync(entries, { level: 6 })
  }
  const path = resolve(ARCHIVE_DIR, name)
  writeFileSync(path, Buffer.from(bytes))
  return path
}

/** The projects page's "+ New" menu, then the import row. */
async function openImportRow(page: Page) {
  await page.getByTestId("project-source-menu-trigger").first().click()
  return page.getByText("Import .shogo…", { exact: false }).first()
}

test.describe("Import .shogo just imports", () => {
  test.describe.configure({ mode: "serial" })
  test.use({ viewport: { width: 1440, height: 900 } })

  let page: Page
  let workspaceId: string
  let sourceProjectId: string
  const suffix = Date.now().toString(36)
  const sourceName = `SHO-211 source ${suffix}`
  const chatText = `SHO-211-CHAT-${suffix}`
  let cleanArchive: string

  test.beforeAll(async ({ browser }) => {
    mkdirSync(ARCHIVE_DIR, { recursive: true })
    page = await browser.newPage()
    await signIn(page)
    workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)

    const created = await apiJson(page, "POST", "/api/projects", {
      name: sourceName,
      workspaceId,
      tier: "starter",
      status: "draft",
      accessLevel: "anyone",
      schemas: [],
      settings: JSON.stringify({ activeMode: "canvas", techStackId: "react-app" }),
    })
    sourceProjectId = created.json?.data?.id ?? created.json?.id
    expect(sourceProjectId, JSON.stringify(created.json)).toBeTruthy()

    // A chat in the archive: chats have no toggle any more, they just travel.
    const session = await apiJson(page, "POST", "/api/chat-sessions", {
      contextId: sourceProjectId,
      contextType: "project",
      inferredName: `Chat ${suffix}`,
      name: `Chat ${suffix}`,
    })
    const sessionId = session.json?.data?.id ?? session.json?.id
    expect(sessionId, JSON.stringify(session.json)).toBeTruthy()
    const message = await apiJson(page, "POST", "/api/chat-messages", {
      sessionId,
      role: "user",
      content: chatText,
    })
    expect(message.status, JSON.stringify(message.json)).toBeLessThan(300)

    cleanArchive = await exportTo(page, sourceProjectId, "clean.shogo", {
      memory: `# MEMORY.md\n\n- Seeded by the SHO-211 e2e (${suffix}).\n`,
    })
  })

  test.afterAll(async () => {
    const projects = await api(page, "GET", `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`)
    const rows = (projects.json?.items ?? projects.json?.data?.items ?? []) as Array<{ id: string; name: string }>
    for (const row of rows) {
      if (row.name.startsWith(sourceName)) {
        await page.request.delete(`${LOCAL_API_BASE}/api/projects/${row.id}`).catch(() => {})
      }
    }
    await page.close()
  })

  test("the menu row opens the file picker itself, and the import lands on the project", async () => {
    await page.goto("/projects")
    const row = await openImportRow(page)

    // The picker is the next thing that happens: no options modal in front of
    // it, so the chooser arrives off the row's own press.
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 })
    await row.click()
    const chooser = await chooserPromise

    // Nothing was rendered between the row and the picker.
    await expect(page.getByText(/start import/i)).toHaveCount(0)
    await expect(page.getByText(/include chat history/i)).toHaveCount(0)
    await expect(page.getByText(/password-protected\?/i)).toHaveCount(0)

    // From here on the test clicks nothing.
    const importRequests: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("/api/projects/import")) {
        importRequests.push(request.postDataBuffer()?.toString("utf8") ?? "")
      }
    })

    await chooser.setFiles(cleanArchive)

    // …and it ends on the imported project, with the toast.
    await page.waitForURL(/\/projects\/[^/?#]+/, { timeout: 120_000 })
    await expect(page.getByText("Project imported")).toBeVisible({ timeout: 30_000 })

    const importedId = page.url().match(/\/projects\/([^/?#]+)/)?.[1] ?? ""
    expect(importedId).toBeTruthy()
    expect(importedId).not.toBe(sourceProjectId)

    // Only one import was sent: the pick is the whole interaction.
    expect(importRequests).toHaveLength(1)

    // Chats come along without a toggle — the seeded transcript is in the
    // imported project, not just a fresh empty chat the UI made on arrival.
    const reExport = await page.request.post(`${LOCAL_API_BASE}/api/projects/${importedId}/export`, {
      data: JSON.stringify({ includeChats: true }),
      headers: { "content-type": "application/json" },
    })
    expect(reExport.status()).toBe(200)
    const entries = unzipSync(new Uint8Array(await reExport.body()))
    const chatHistory = Object.keys(entries).filter((entry) => entry.startsWith("chat-history/"))
    expect(chatHistory.length).toBeGreaterThan(0)
    const transcripts = chatHistory.map((entry) => Buffer.from(entries[entry]).toString("utf8")).join("\n")
    expect(transcripts).toContain(chatText)
  })

  test("a cancelled picker opens nothing and leaves the user on the projects page", async () => {
    await page.goto("/projects")
    const row = await openImportRow(page)

    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 })
    await row.click()
    await chooserPromise

    // Walking away from the OS dialog is a normal outcome: no empty import
    // modal, no navigation.
    await page.waitForTimeout(1_500)
    await expect(page.getByText(/importing\.\.\./i)).toHaveCount(0)
    await expect(page.getByText("Import project")).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe("/projects")
  })

  test("an import that reports a warning keeps the summary instead of navigating", async () => {
    // The raw export carries the placeholder MEMORY.md, which the importer
    // reports as a warning — the one reason to stay on the done screen.
    const stubArchive = await exportTo(page, sourceProjectId, "stub.shogo")

    await page.goto("/projects")
    const row = await openImportRow(page)
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 })
    await row.click()
    const chooser = await chooserPromise
    await chooser.setFiles(stubArchive)

    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/no MEMORY\.md content found/i)).toBeVisible()
    // Still on the projects page: the warning was not thrown away.
    expect(new URL(page.url()).pathname).toBe("/projects")
  })

  test("an encrypted archive asks only for its password, then imports", async () => {
    const encryptedArchive = await exportTo(page, sourceProjectId, "encrypted.shogo", {
      password: "hunter2",
    })

    await page.goto("/projects")
    const row = await openImportRow(page)
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 })
    await row.click()
    const chooser = await chooserPromise
    await chooser.setFiles(encryptedArchive)

    // The header sniff has to agree with what the export wrote: one required
    // field, and no import until it is submitted.
    const field = page.getByPlaceholder(/archive password/i)
    await expect(field).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/include chat history/i)).toHaveCount(0)

    // A wrong password is a correction, not a dead end.
    await field.fill("wrong-password")
    await page.getByRole("button", { name: /^import$/i }).click()
    await expect(page.getByText(/incorrect password/i)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByPlaceholder(/archive password/i)).toBeVisible()

    // The right one gets through (the stub MEMORY.md warning keeps the
    // summary up, which is itself proof the import completed).
    await field.fill("hunter2")
    await page.getByRole("button", { name: /^import$/i }).click()
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 120_000 })
  })
})

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-215 — drag a file (or a whole folder) from your computer into the IDE and
 * it uploads: onto a folder row it lands in that folder, anywhere else in the
 * IDE it lands in the workspace root, and nothing is ever refused.
 *
 * Before the card, only a tree row and a 40 px strip under it accepted the
 * drop: the tree container never called `preventDefault` for OS files, so most
 * of the sidebar refused the drop, and in Electron the drop fell through to
 * `will-navigate`. Folders were skipped entirely.
 *
 * Playwright cannot perform a real OS drag, so each drop is dispatched as a
 * `DragEvent` carrying a `DataTransfer` built in the page. A `DataTransfer`
 * only gains `types: ["Files"]` from a real OS drag, so the harness stamps it
 * (that is the one field the browser does not synthesise); everything after
 * that — the capture-phase zone, the recursive `webkitGetAsEntry` walk, the
 * destination lookup, the upload, the toast — is the app's real code.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test --config e2e/local/playwright.config.ts \
 *     ide-os-drop-upload --project chromium --retries 0
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:8002"
/** Metro compiles `/projects/:id` on demand; the IDE then boots a runtime. */
const IDE_READY_MS = 240_000

test.setTimeout(600_000)

let context: BrowserContext
let projectId: string
let page: Page

interface ProjectFile {
  content?: string
  encoding?: string
  bytes?: number
}

async function apiJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await context.request.fetch(`${API}${route}`, {
    method,
    data: body,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

/** The IDE's own file API, in the same `?scope=project` path space as its tree. */
async function seedFile(path: string, content: string): Promise<void> {
  const deadline = Date.now() + 180_000
  let last = ""
  while (Date.now() < deadline) {
    const res = await context.request.put(
      `${API}/api/projects/${projectId}/agent-proxy/agent/workspace/files/${path}?scope=project`,
      { data: { content } },
    )
    if (res.ok()) return
    last = `${res.status()} ${await res.text()}`
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`could not seed ${path}: ${last}`)
}

/** Read a file back through the runtime — proof the bytes landed, not just a toast. */
async function readFile(path: string): Promise<ProjectFile | null> {
  const res = await context.request.get(
    `${API}/api/projects/${projectId}/agent-proxy/agent/workspace/files/${path}?scope=project`,
  )
  if (!res.ok()) return null
  return (await res.json()) as ProjectFile
}

async function exists(path: string): Promise<boolean> {
  return (await readFile(path)) !== null
}

/**
 * Dispatch an OS-file drop on `selector`.
 *
 * `entries` are the paths as the OS reports them: a nested path is a folder
 * chain (`docs/sub/b.md` → dir `docs` → dir `sub` → file `b.md`), which is
 * exactly the `FileSystemEntry` tree `webkitGetAsEntry()` hands the app.
 */
async function dropOsFiles(
  target: Page,
  selector: string | { x: number; y: number } | { text: string },
  entries: Array<{ path: string; content?: string; type?: string }>,
  opts: { commit?: boolean } = {},
): Promise<{ types: string[] }> {
  return target.evaluate(
    ({ selector, entries, commit }) => {
      const el =
        typeof selector === "string"
          ? document.querySelector(selector)
          : "x" in selector
            ? document.elementFromPoint(selector.x, selector.y)
            : Array.from(document.querySelectorAll("span, div")).find(
                (node) => node.children.length === 0 && node.textContent?.trim() === selector.text,
              )
      if (!el) throw new Error(`no element for ${JSON.stringify(selector)}`)

      type TreeNode = { name: string; children: Map<string, TreeNode>; file?: File }

      const roots = new Map<string, TreeNode>()
      for (const entry of entries) {
        const segments = entry.path.split("/").filter(Boolean)
        const name = segments[segments.length - 1]!
        const file = new File([entry.content ?? "dropped"], name, {
          type: entry.type ?? "text/plain",
        })
        let level = roots
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i]!
          let node = level.get(segment)
          if (!node) {
            node = { name: segment, children: new Map() }
            level.set(segment, node)
          }
          if (i === segments.length - 1) node.file = file
          level = node.children
        }
      }

      const fileEntry = (name: string, file: File) => ({
        isFile: true,
        isDirectory: false,
        name,
        file: (ok: (f: File) => void) => ok(file),
      })
      const dirEntry = (node: TreeNode): unknown => ({
        isFile: false,
        isDirectory: true,
        name: node.name,
        createReader: () => {
          let served = false
          return {
            readEntries: (ok: (found: unknown[]) => void) => {
              if (served) return ok([])
              served = true
              ok(
                Array.from(node.children.values()).map((child) =>
                  child.file ? fileEntry(child.name, child.file) : dirEntry(child),
                ),
              )
            },
          }
        },
      })

      const dt = new DataTransfer()
      // A real OS drop gives one `DataTransferItem` per dropped top-level entry,
      // each able to hand back a `FileSystemEntry` (`webkitGetAsEntry`). Chromium
      // does not keep a patched method on a live `DataTransferItem`, so the list
      // itself is stubbed with the same shape: `kind`, `getAsFile`, and the
      // entry tree. `types` is stubbed for the same reason — only a real OS drag
      // reports "Files".
      const items = Array.from(roots.values()).map((node) => {
        const file = node.file ?? new File([], node.name)
        return {
          kind: "file",
          type: file.type,
          getAsFile: () => file,
          webkitGetAsEntry: () => (node.file ? fileEntry(node.name, node.file) : dirEntry(node)),
        }
      })
      Object.defineProperty(dt, "items", { configurable: true, value: items })
      Object.defineProperty(dt, "types", { configurable: true, value: ["Files"] })
      const types = ["Files"]

      for (const type of ["dragenter", "dragover"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      if (commit !== false) {
        el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      return { types }
    },
    { selector, entries, commit: opts.commit !== false },
  )
}

/** An in-app tree drag: the row's own `dragstart` fills in `application/x-ide-path`. */
async function dragTreeRow(from: string, to: string): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const source = document.querySelector(from)
      const target = document.querySelector(to)
      if (!source || !target) throw new Error(`missing ${!source ? from : to}`)
      const dt = new DataTransfer()
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }))
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { from, to },
  )
}

const row = (path: string) => `[data-tree-path="${path}"]`

/**
 * A folder's children only exist in the DOM once it is expanded (and only in
 * the tree at all once the walker has descended into it).
 */
async function expandFolder(path: string, child: string): Promise<void> {
  const folder = page.locator(row(path)).first()
  await expect(folder).toBeVisible({ timeout: 30_000 })
  // Only click when the row is actually collapsed — clicking an expanded folder
  // collapses it, and a row can lag the upload by a moment while `loadRoot`
  // lands.
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click()
  await expect(folder).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 })
  await expect(page.locator(row(child)).first()).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(600_000)
  const baseURL = String(info.project.use.baseURL)
  context = await browser.newContext({ baseURL })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data ?? workspaces ?? []
  const workspace = list.find((w) => w?.kind !== "personal") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)

  const created = await apiJson<any>("POST", "/api/projects", {
    name: `SHO-215 drop ${Date.now()}`,
    workspaceId: workspace.id,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  projectId = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)

  // A folder to aim at, a file to open in Monaco, and a folder deep enough that
  // the tree has never loaded its children (`eagerDepth: 1`).
  await seedFile("notes/keep.md", "keep me")
  await seedFile("keep.ts", "export const keep = 1\n")
  await seedFile("deep/sub/x.txt", "original")

  page = await context.newPage()
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  // The project page lands on Canvas; the IDE is its own tab. `?tab=ide` is not
  // honoured on a cold project open, and clicking is what a user does anyway.
  const ideTab = page.locator('[aria-label="IDE"]').first()
  await expect(ideTab).toBeVisible({ timeout: IDE_READY_MS })
  await ideTab.click()
  await expect(page.locator(row("keep.ts")).first()).toBeVisible({ timeout: IDE_READY_MS })
  // Open the seed file so there is a Monaco surface to drop on (AC3).
  await page.locator(row("keep.ts")).first().click()
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: IDE_READY_MS })
})

test.afterAll(async () => {
  if (projectId) await context.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
  await context?.close()
})

test.describe.serial("SHO-215 — OS file drops in the IDE", () => {
  test("a file dropped on a folder row lands in that folder", async () => {
    await expandFolder("notes", "notes/keep.md")

    await dropOsFiles(page, row("notes"), [{ path: "from-os.txt", content: "into notes" }])

    // The toast is the first signal and only lives ~3 s, so assert it before the
    // slower ones. It names the path it wrote and the folder it landed in.
    await expect(page.getByText("Uploaded notes/from-os.txt to notes").first()).toBeVisible({
      timeout: 15_000,
    })
    expect((await readFile("notes/from-os.txt"))?.content).toBe("into notes")
    expect(await exists("from-os.txt")).toBe(false)
    await expect(page.locator(row("notes/from-os.txt")).first()).toBeVisible({ timeout: 30_000 })
  })

  test("a file dropped on a file row lands in that file's folder", async () => {
    await expandFolder("notes", "notes/keep.md")

    await dropOsFiles(page, row("notes/keep.md"), [{ path: "beside.txt", content: "beside" }])

    await expect
      .poll(async () => (await readFile("notes/beside.txt"))?.content, { timeout: 30_000 })
      .toBe("beside")
    await expect(page.locator(row("notes/beside.txt")).first()).toBeVisible({ timeout: 30_000 })
  })

  test("dropping on the editor shows the overlay, uploads to the root and never navigates", async () => {
    const navigations: string[] = []
    const onFrame = (frame: { page: () => Page; url: () => string }) => {
      if (frame.page() === page) navigations.push(frame.url())
    }
    page.on("framenavigated", onFrame)
    const urlBefore = page.url()
    const editorBefore = await page.locator(".monaco-editor .view-lines").first().innerText()

    // Hover first: the overlay must be up while the drag is in flight.
    await dropOsFiles(page, ".monaco-editor", [{ path: "into-root.txt", content: "root" }], {
      commit: false,
    })
    await expect(page.getByText("Drop to upload").first()).toBeVisible({ timeout: 15_000 })

    // Then commit the drop.
    await dropOsFiles(page, ".monaco-editor", [{ path: "into-root.txt", content: "root" }])

    await expect
      .poll(async () => (await readFile("into-root.txt"))?.content, { timeout: 30_000 })
      .toBe("root")
    await expect(page.getByText("Drop to upload")).toHaveCount(0)
    await expect(page.getByText("Uploaded into-root.txt to", { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    })

    // AC3: the window must not navigate, and Monaco must not paste the file.
    expect(page.url()).toBe(urlBefore)
    expect(navigations).toEqual([])
    const editorAfter = await page.locator(".monaco-editor .view-lines").first().innerText()
    expect(editorAfter).toBe(editorBefore)
    page.off("framenavigated", onFrame)
  })

  test("a dropped folder tree recreates its sub-folders", async () => {
    await dropOsFiles(page, row("notes"), [
      { path: "docs/a.md", content: "a" },
      { path: "docs/sub/b.md", content: "b" },
      { path: "loose.txt", content: "loose" },
    ])

    const seenToasts = await page.evaluate(async () => {
      const found: string[] = []
      const started = Date.now()
      while (Date.now() - started < 20_000) {
        for (const el of Array.from(document.querySelectorAll("div"))) {
          const text = el.textContent ?? ""
          if (/^Upload(ed|ing) /.test(text) && el.children.length === 0 && !found.includes(text)) {
            found.push(text)
          }
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      return found
    })
    expect(seenToasts, JSON.stringify(seenToasts)).toContain("Uploaded 3 files to notes")
    expect((await readFile("notes/docs/a.md"))?.content).toBe("a")
    expect((await readFile("notes/docs/sub/b.md"))?.content).toBe("b")
    expect((await readFile("notes/loose.txt"))?.content).toBe("loose")
  })

  test("a name clash asks, and Replace rewrites the file", async () => {
    await dropOsFiles(page, row("notes"), [{ path: "from-os.txt", content: "replaced!" }])

    const dialog = page.getByRole("alertdialog", { name: "Replace from-os.txt?" })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Replace", exact: true }).click()

    await expect
      .poll(async () => (await readFile("notes/from-os.txt"))?.content, { timeout: 30_000 })
      .toBe("replaced!")
  })

  test("Skip all leaves every clashing file alone", async () => {
    await expandFolder("notes", "notes/keep.md")
    // Seed the two files through a drop, so the tree knows about them (the
    // clash prompt is driven by what the client has loaded).
    await dropOsFiles(page, row("notes"), [
      { path: "skip-a.txt", content: "original a" },
      { path: "skip-b.txt", content: "original b" },
    ])
    await expect
      .poll(async () => (await readFile("notes/skip-a.txt"))?.content, { timeout: 30_000 })
      .toBe("original a")
    // The clash check runs against the tree the client holds, so wait for the
    // post-upload refresh to land before dropping again.
    await expandFolder("notes", "notes/skip-a.txt")

    await dropOsFiles(page, row("notes"), [
      { path: "skip-a.txt", content: "new a" },
      { path: "skip-b.txt", content: "new b" },
    ])

    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Skip all", exact: true }).click()

    await expect.poll(async () => (await readFile("notes/skip-a.txt"))?.content).toBe("original a")
    await expect.poll(async () => (await readFile("notes/skip-b.txt"))?.content).toBe("original b")
  })

  // SHO-225: the clash set is built from the *loaded* tree, so a clash inside a
  // folder that was never expanded is not detected — the drop overwrites the
  // file with no Replace/Skip prompt. Flip this on when SHO-225 lands.
  test.fixme("a clash in a folder whose children were never loaded still asks", async () => {
    await expect(page.locator(row("deep/sub")).first()).toBeVisible({ timeout: 30_000 })
    expect(await page.locator(row("deep/sub/x.txt")).count()).toBe(0)

    await dropOsFiles(page, row("deep/sub"), [{ path: "x.txt", content: "new" }])

    const dialog = page.getByRole("alertdialog", { name: "Replace x.txt?" })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Skip", exact: true }).click()
    await expect.poll(async () => (await readFile("deep/sub/x.txt"))?.content).toBe("original")
  })

  test("dropping on the Explorer header uploads to the workspace root", async () => {
    // Part of the sidebar that used to refuse the drop outright: no row, just
    // the Explorer title bar above the tree.
    const header = { text: "Explorer" }

    await dropOsFiles(page, header, [{ path: "header-drop.txt", content: "header" }], { commit: false })
    await expect(page.getByText("Drop to upload").first()).toBeVisible({ timeout: 15_000 })
    await dropOsFiles(page, header, [{ path: "header-drop.txt", content: "header" }])

    await expect
      .poll(async () => (await readFile("header-drop.txt"))?.content, { timeout: 30_000 })
      .toBe("header")
    await expect(page.getByText("Drop to upload")).toHaveCount(0)
  })

  test("the bottom drawer accepts a drop even though it lives outside the Workbench", async () => {
    // The card's one deviation: DrawerHost mounts the panel at project-layout
    // level, so the zone is document-level capture gated by `[data-os-drop-scope]`.
    await page.keyboard.press("Meta+j")
    const scope = page.locator("[data-os-drop-scope]").first()
    await expect(scope).toBeVisible({ timeout: 30_000 })

    await dropOsFiles(page, "[data-os-drop-scope]", [{ path: "from-drawer.txt", content: "drawer" }], {
      commit: false,
    })
    await expect(page.getByText("Drop to upload").first()).toBeVisible({ timeout: 15_000 })
    await dropOsFiles(page, "[data-os-drop-scope]", [{ path: "from-drawer.txt", content: "drawer" }])

    await expect
      .poll(async () => (await readFile("from-drawer.txt"))?.content, { timeout: 30_000 })
      .toBe("drawer")
    await expect(page.getByText("Drop to upload")).toHaveCount(0)
  })

  test("a file over 25 MB is skipped by name and the rest still upload", async () => {
    await dropOsFiles(page, row("notes"), [
      { path: "too-big.bin", content: "x".repeat(26 * 1024 * 1024) },
      { path: "small.txt", content: "small" },
    ])

    await expect(page.getByText(/too-big\.bin is larger than 25 MB — skipped/).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => (await readFile("notes/small.txt"))?.content, { timeout: 30_000 })
      .toBe("small")
    expect(await exists("notes/too-big.bin")).toBe(false)
  })

  test("dragging a tree row onto a folder still moves it, with no upload", async () => {
    await dragTreeRow(row("keep.ts"), row("notes"))

    await expect.poll(async () => exists("notes/keep.ts"), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => exists("keep.ts"), { timeout: 30_000 }).toBe(false)
    await expect(page.getByText(/^Uploaded /)).toHaveCount(0)
  })

  test("an in-app drag never shows the upload overlay", async () => {
    await expandFolder("notes", "notes/from-os.txt")
    await page.evaluate((to) => {
      const source = document.querySelector('[data-tree-path="notes/from-os.txt"]')
      const target = document.querySelector(to)
      if (!source || !target) throw new Error("rows missing")
      const dt = new DataTransfer()
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, row("notes"))

    await expect(page.getByText("Drop to upload")).toHaveCount(0)
  })
})

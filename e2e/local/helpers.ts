// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { Locator, Page } from "@playwright/test"

export const LOCAL_API_BASE = process.env.E2E_API_URL || process.env.STAGING_API_URL || "http://localhost:8002"

/**
 * Write a workspace selection into a document's two stores.
 *
 * `localStorage` is only the default a brand-new tab starts from; a tab keeps
 * its own selection in `sessionStorage` and that wins over the shared value
 * (SHO-390). A seed that writes the shared key alone therefore moves nothing in
 * a tab that has already picked a workspace — which is why the apps' own
 * switcher writes both. The kind is the `{ id, kind }` JSON that
 * `readCachedWorkspaceKind` parses back.
 *
 * Page-function: called through `page.evaluate(...)`, or serialised into an
 * `addInitScript`, so it must stay self-contained.
 */
export function writeActiveWorkspaceSelection([id, kind]: readonly [string, "team" | "personal"]): void {
  const cached = JSON.stringify({ id, kind })
  for (const store of [window.sessionStorage, window.localStorage]) {
    store.setItem("shogo:active-workspace-id", id)
    store.setItem("shogo:active-workspace-kind", cached)
  }
}

/** Put the loaded page's tab on `id`, in both stores. Reload to apply it. */
export async function setActiveWorkspace(
  page: Page,
  id: string,
  kind: "team" | "personal" = "team",
): Promise<void> {
  await page.evaluate(writeActiveWorkspaceSelection, [id, kind] as const)
}

/**
 * Put the page on `id` before every load, in both stores.
 *
 * `addInitScript` alone is not enough with a single store: it runs again on
 * each navigation, but a tab that has already booted keeps its own
 * `sessionStorage` selection, so a script that writes only the shared
 * `localStorage` default changes nothing on the second load (SHO-390). `kind:
 * null` writes the id and clears the cached kind from both stores, for the
 * "nothing cached yet" chrome cases.
 */
export async function seedActiveWorkspace(
  page: Page,
  id: string,
  kind: "team" | "personal" | null = "team",
): Promise<void> {
  await page.addInitScript(
    ([id, kind]: readonly [string, "team" | "personal" | null]) => {
      for (const store of [window.sessionStorage, window.localStorage]) {
        store.setItem("shogo:active-workspace-id", id)
        if (kind === null) store.removeItem("shogo:active-workspace-kind")
        else store.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind }))
      }
    },
    [id, kind] as const,
  )
}

/**
 * The workspace this tab is on, read the way the app reads it: the tab's own
 * selection first, the shared default only when the tab has nothing of its own.
 * Page-function: call it through `page.evaluate(readActiveWorkspaceId)`.
 */
export function readActiveWorkspaceId(): string | null {
  return (
    window.sessionStorage.getItem("shogo:active-workspace-id") ??
    window.localStorage.getItem("shogo:active-workspace-id")
  )
}

/**
 * What is painted on top of an element's own centre, or `null` when nothing is.
 * Occlusion is invisible to `toBeVisible()` — a covered element still has a box —
 * so this asks the browser for the paint stack instead.
 *
 * Elements that are `pointer-events: none` are skipped by hit testing while
 * still being painted, so that is switched off for the measurement (paint order
 * does not depend on it) and restored straight after. The label bubbles use it
 * so they never steal hover from the icon they belong to.
 */
export async function coveredBy(target: Locator): Promise<string | null> {
  return target.evaluate((el) => {
    const node = el as HTMLElement
    const previous = node.style.pointerEvents
    node.style.pointerEvents = "auto"
    const box = node.getBoundingClientRect()
    const top = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)[0] as HTMLElement | undefined
    node.style.pointerEvents = previous
    if (!top || node.contains(top)) return null
    const classes = typeof top.className === "string" ? top.className.split(" ").slice(0, 3).join(".") : ""
    return `${top.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`
  })
}

/**
 * Expo's web dev server paints `#error-toast` above the app whenever the bundle
 * logged anything, and an empty toast still swallows pointer events — a click
 * on a control underneath never lands (`<div id="error-toast"> intercepts
 * pointer events`, SHO-222). It is a dev-server artifact that the production
 * bundle does not have, so a spec that only wants to tap the app keeps it out
 * of the way, including a toast that appears mid-test.
 */
export async function ignoreDevErrorToast(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const drop = () => document.getElementById("error-toast")?.remove()
    drop()
    // `document` itself, not documentElement: an init script can run before the
    // root element exists.
    new MutationObserver(drop).observe(document, { childList: true, subtree: true })
  })
}

/**
 * Local mode opens the Personal workspace (the companion chat); the project
 * home ("What are we building") lives in the Team workspace. Make the team
 * workspace active and land on its home.
 *
 * The home is `/home` since SHO-4: `/` is now the workspace agent chat with a
 * fresh session for a team workspace.
 */
export async function openTeamHome(page: Page, timeout = 30_000): Promise<void> {
  await page.goto("/")
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .or(page.getByRole("tab", { name: "Sign Up" }))
    .first()
    .waitFor({ state: "visible", timeout })

  const teamId = await page.evaluate(async (apiBase) => {
    const res = await fetch(`${apiBase}/api/workspaces`, { credentials: "include" })
    const body = await res.json()
    const items = (body?.items ?? body?.data?.items ?? []) as Array<{ id: string; kind?: string }>
    return items.find((w) => w.kind !== "personal")?.id ?? null
  }, LOCAL_API_BASE)
  if (!teamId) throw new Error("local stack has no team workspace")

  // This tab's own selection is what the app reads (SHO-390): `sessionStorage`
  // wins over the shared `localStorage` default, so writing only the latter
  // leaves a tab that already has a workspace on it exactly where it was.
  await page.evaluate(writeActiveWorkspaceSelection, [teamId, "team"] as const)
  await page.goto("/home")
  await page.getByText("What are we building", { exact: false }).first().waitFor({ state: "visible", timeout })
}

/** Start a project from the home composer and wait for its (mocked) bootstrap turn. */
export async function startProjectWithBootstrapTurn(page: Page): Promise<void> {
  await openTeamHome(page)
  const home = page.getByTestId("home-composer-input").or(
    page.getByRole("textbox", { name: "Describe the agent you want to build" }),
  )
  await home.click()
  await home.fill("Build a tiny app for the resume-replay E2E")
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/projects\//, { timeout: 30_000 })
  await page.getByText("Bootstrap done.").waitFor({ state: "visible", timeout: 30_000 })
}

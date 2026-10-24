/**
 * A user path is never answered by the admin console (SHO-115).
 *
 * Four admin pages (Marketing Analytics, Marketplace, Meetings, Projects) used
 * to share their URL with the end-user page of the same name — `(admin)` and
 * `(app)` are groups, so both files resolved to `/analytics` etc. A *direct*
 * request (a bookmark, a shared link, a cold load) then landed on the admin
 * console, which is invisible to in-app navigation because it pushes
 * `/(admin)/analytics` with the group segment included.
 *
 * The console now lives under `/admin/*`, and `route-path-collisions.test.ts`
 * pins that at the resolver. This spec pins what a browser actually gets: the
 * local user is a super admin, so nothing but route ownership keeps the admin
 * console away from these four paths.
 *
 * The marketplace tab strip's `href`/`match` strings do not reach the router
 * here — `/admin/marketplace` cannot be cold-loaded until the local-mode admin
 * URL race is fixed (SHO-116) — so the resolver guard pins those literals.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"

/** Only the admin console renders this ("Shogo Admin" is its sidebar header). */
const adminChrome = (page: Page) => page.getByText("Shogo Admin", { exact: true })

/**
 * The console is on screen. `Shogo Admin` is the sidebar header, which a narrow
 * layout keeps inside a closed drawer, so the phone header's "Admin console"
 * stands in for it there.
 */
const adminConsole = (page: Page) =>
  adminChrome(page).or(page.getByText("Admin console", { exact: true }))

const CASES: Array<{ path: string; ready: (page: Page) => Locator }> = [
  { path: "/analytics", ready: (page) => page.getByTestId("analytics-screen") },
  {
    path: "/marketplace",
    ready: (page) =>
      page.getByLabel("Agent packs").or(page.getByLabel("My installs")).first(),
  },
  { path: "/meetings", ready: (page) => page.getByLabel("Search meetings").first() },
  {
    path: "/projects",
    ready: (page) =>
      page
        .getByLabel("Create a new project")
        .or(page.getByLabel("Search projects"))
        .or(page.getByText("No projects yet"))
        .first(),
  },
]

for (const { path, ready } of CASES) {
  test(`cold load of ${path} renders the end-user page, never the admin console`, async ({
    page,
  }) => {
    await page.goto(path)
    await expect(ready(page)).toBeVisible({ timeout: 45_000 })
    await expect(adminChrome(page)).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(path)
  })
}

/**
 * Get into the admin console. Local mode has no `/admin` index and a cold load
 * of any `(admin)` URL races the auth gate (SHO-116, separate card), so try the
 * URL first and fall back to the in-app Admin entry the sidebar offers.
 */
async function enterAdminConsole(page: Page): Promise<void> {
  await page.goto("/admin/projects")
  const shown = await adminConsole(page)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (shown) return

  await page.goto("/")
  await page
    .getByRole("navigation", { name: "App sidebar" })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
  await page.getByRole("link", { name: "Admin", exact: true }).first().click()
  await expect(adminConsole(page).first()).toBeVisible({ timeout: 30_000 })
}

/** The wide header's second line is `adminPageTitle(pathname)`. */
const headerTitle = (page: Page) =>
  page.getByText("Shogo / Admin console").locator("..")

const adminNav = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true }).first()

test("every moved admin page opens from its nav item, with its header title", async ({
  page,
}) => {
  await enterAdminConsole(page)
  await expect(headerTitle(page)).toBeVisible()

  for (const [label, url, title] of [
    ["Marketing Analytics", /\/admin\/analytics$/, "Marketing Analytics"],
    ["Meetings", /\/admin\/meetings$/, "Meetings"],
    ["Projects", /\/admin\/projects$/, "Projects"],
  ] as const) {
    await adminNav(page, label).click()
    await expect(page).toHaveURL(url)
    await expect(headerTitle(page)).toContainText(title)
  }
})

test("the phone admin header titles the moved pages too", async ({ page }) => {
  await enterAdminConsole(page)
  await page.setViewportSize({ width: 390, height: 844 })
  // Narrow layouts swap the wide header for the drawer header.
  await expect(page.getByText("Admin console", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Open menu" }).first().click()
  await adminNav(page, "Marketing Analytics").click()

  await expect(page).toHaveURL(/\/admin\/analytics$/)
  await expect(
    page.getByText("Admin console", { exact: true }).locator(".."),
  ).toContainText("Marketing Analytics")
})

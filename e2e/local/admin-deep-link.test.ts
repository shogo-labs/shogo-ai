/**
 * A cold admin deep link opens its own page in local mode (SHO-116).
 *
 * `/admin/*` lives in the `(admin)` route group, so a direct GET never passes
 * through `app/index.tsx` — the only place local mode used to auto-sign-in. The
 * console's guard read the still-empty session, decided the visitor was not an
 * admin, and forwarded to `/(app)` before auto-sign-in could land; a second
 * effect in the same layout answered the router's transient `/` (expo-router
 * publishes its initial navigation state as `/` on every cold load, `(app)`
 * links included) by hopping to Projects. Either way the requested page never
 * opened — reload and bookmark included — while in-app navigation worked,
 * because the guard had long since re-rendered.
 *
 * Each case runs in a fresh browser context with no cookies, so it is a
 * genuinely cold load: the session has to be created through
 * `/api/local/auto-sign-in` while the console is already rendering the page
 * that was asked for.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"

/** Only the admin console renders this (the wide header's breadcrumb line). */
const header = (page: Page): Locator =>
  page.getByText("Shogo / Admin console").locator("..")

const CASES: Array<{ path: string; title: string }> = [
  // An (admin) page that kept its top-level URL.
  { path: "/general", title: "General" },
  { path: "/admin/settings", title: "AI Settings" },
  // Moved under /admin/* by SHO-115; unreachable by URL until this card.
  { path: "/admin/projects", title: "Projects" },
]

for (const { path, title } of CASES) {
  test(`cold load of ${path} settles on the admin page`, async ({ page }) => {
    await page.goto(path)

    // The header title is `adminPageTitle(pathname)`, so it reads `title` only
    // when the console mounted on the page that was asked for.
    await expect(header(page)).toContainText(title, { timeout: 60_000 })
    expect(new URL(page.url()).pathname).toBe(path)

    // `gate: loading` holds until local auto-sign-in has landed; nothing may
    // navigate after that. The router's own initial-state write is earlier and
    // settles on its own, so only the post-render window is asserted here.
    await page.waitForTimeout(1_000)
    expect(new URL(page.url()).pathname).toBe(path)
    await expect(header(page)).toContainText(title)
  })
}

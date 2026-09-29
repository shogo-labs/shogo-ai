/**
 * A signed-out browser opening an (app) deep link directly used to bounce
 * between the (app) auth guard and "/" until React aborted with "Maximum
 * update depth exceeded". Local mode must sign in in place and keep the URL.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"

const CASES: Array<{ path: string; ready: (page: Page) => Locator }> = [
  { path: "/activity", ready: (page) => page.getByRole("navigation", { name: "App sidebar" }) },
  { path: "/goals", ready: (page) => page.getByRole("navigation", { name: "App sidebar" }) },
]

for (const { path, ready } of CASES) {
  test(`cold signed-out load of ${path} signs in without a redirect loop`, async ({ page }) => {
    let replaces = 0
    await page.exposeFunction("__countReplace", () => { replaces++ })
    await page.addInitScript(() => {
      const orig = history.replaceState.bind(history)
      history.replaceState = (...args: Parameters<History["replaceState"]>) => {
        ;(window as unknown as { __countReplace: () => void }).__countReplace()
        return orig(...args)
      }
    })

    await page.goto(path)
    await expect(ready(page)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Maximum update depth")).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(path)
    expect(replaces, "history.replaceState storm").toBeLessThan(10)
  })
}

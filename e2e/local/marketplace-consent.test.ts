// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Marketplace consent sheet on desktop and phone: installing an app with a
 * `shogo.app.json` first shows what it asks for, a missing connected app is
 * explained, and accepting sends the consent (with the optional scopes ticked)
 * to the install endpoint.
 *
 * The listing endpoints are stubbed in the browser: local mode can't publish
 * to the marketplace without a cloud account. The server side of consent is
 * covered by e2e/events/marketplace-app.integration.test.ts.
 */
import { expect, test, type Page, type Route } from "@playwright/test"

const SLUG = `consent-e2e-${Date.now().toString(36)}`

const listing = {
  id: "listing-consent-e2e",
  slug: SLUG,
  title: "Welcome Bot",
  shortDescription: "Greets new members and triages GitHub issues",
  longDescription: null,
  category: null,
  tags: [],
  iconUrl: null,
  screenshotUrls: [],
  pricingModel: "free",
  installCount: 0,
  averageRating: 0,
  reviewCount: 0,
  currentVersion: "1.0.0",
  creator: {
    id: "creator-e2e",
    displayName: "Creator",
    creatorTier: "newcomer",
    reputationScore: 0,
    verified: false,
    totalAgentsPublished: 1,
    totalInstalls: 0,
  },
}

const consent = {
  version: "1.0.0",
  scopes: [{ scope: "members:read", description: "See who joins and leaves the workspace" }],
  optionalScopes: [{ scope: "members:read.email", description: "See members' email addresses" }],
  requiredToolkits: ["github"],
  events: [
    { type: "member.joined", target: "hook", name: "Welcome" },
    { type: "composio.github.GITHUB_ISSUE_ADDED_EVENT", target: "agent" },
  ],
}

async function stubListing(page: Page, installs: unknown[]) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  await page.route(`**/api/marketplace/${SLUG}`, (route) => json(route, { listing }))
  await page.route(`**/api/marketplace/${SLUG}/consent`, (route) => json(route, { consent }))
  await page.route(`**/api/marketplace/${SLUG}/reviews**`, (route) => json(route, { items: [], total: 0, page: 1, limit: 50, totalPages: 0 }))
  await page.route(`**/api/marketplace?**`, (route) => json(route, { items: [] }))
  await page.route(`**/api/marketplace/${SLUG}/install`, async (route) => {
    const body = route.request().postDataJSON()
    installs.push(body)
    if (installs.length === 1) {
      return json(route, { error: "needs_connection", message: "Connect github first", toolkits: ["github"] }, 409)
    }
    return json(route, { ok: true, projectId: "consent-e2e-project" })
  })
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`installing an app asks for consent first (${viewport.name})`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const installs: any[] = []
    await stubListing(page, installs)
    await page.goto(`/marketplace/${SLUG}`)
    await page.getByText("Use this agent").first().click()

    const sheet = page.getByTestId("app-consent-sheet")
    await expect(sheet).toBeVisible({ timeout: 15_000 })
    await expect(sheet.getByText("Allow Welcome Bot?")).toBeVisible()
    await expect(sheet.getByText("See who joins and leaves the workspace")).toBeVisible()
    await expect(sheet.getByText("Github", { exact: true })).toBeVisible()
    expect(installs).toHaveLength(0)

    await sheet.getByTestId("app-consent-accept").click()
    await expect(sheet.getByTestId("app-consent-error")).toContainText("Connect Github to this workspace first")
    expect(installs[0]).toMatchObject({ consent: { accept: true, optionalScopes: [] } })

    await sheet.getByLabel("See members' email addresses").click()
    await sheet.getByTestId("app-consent-accept").click()
    await expect(page).toHaveURL(/\/projects\/consent-e2e-project/, { timeout: 15_000 })
    expect(installs[1]).toMatchObject({ consent: { accept: true, optionalScopes: ["members:read.email"] } })
  })
}

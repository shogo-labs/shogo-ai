// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "@playwright/test"
import { createProjectAndWait, makeTestUser, signUpAndOnboard } from "./helpers"

/**
 * A project-added HTTP port can be published, and its preview URL carries
 * that port. Skipped unless the staging workspace has the docker project
 * class turned on (`E2E_DOCKER_CLASS=1`). Do not add this file to the
 * critical-path list: it needs a docker-class machine and is not part of
 * every deploy.
 *
 *   E2E_DOCKER_CLASS=1 E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts docker-custom-port
 */
const enabled = process.env.E2E_DOCKER_CLASS === "1"

test.describe("project-added preview port", () => {
  test.skip(!enabled, "Set E2E_DOCKER_CLASS=1 on a workspace with the docker class enabled")

  test("publishing port 3000 yields a 3000-- preview URL", async ({ page }) => {
    test.setTimeout(180_000)
    const user = makeTestUser("DockerPort")
    await signUpAndOnboard(page, user)
    await createProjectAndWait(page, "Create a one-line README and stop.")

    const projectId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()
    expect(projectId).toBeTruthy()

    const created = await page.request.post(`/api/projects/${projectId}/ports`, {
      data: { port: 3000, protocol: "http", label: "app" },
    })
    expect(created.ok(), await created.text()).toBe(true)

    const published = await page.request.patch(`/api/projects/${projectId}/ports/3000`, {
      data: { visibility: "preview" },
    })
    expect(published.ok(), await published.text()).toBe(true)
    const body = await published.json()
    const port = (body.ports as Array<{ port: number; previewUrl?: string }>).find((p) => p.port === 3000)
    expect(port?.previewUrl).toContain(`3000--${projectId}`)
  })
})

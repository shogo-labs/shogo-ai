// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test } from "@playwright/test"
import { createProjectAndWait, makeTestUser, sendChatMessage, signUpAndOnboard, waitForAgentIdle } from "./helpers"

/**
 * Odin's local-generic stack on a docker-class cloud project: the agent
 * clones the two repos, runs `make shogo-up`, and the port-8000 preview
 * serves the signup page. Skipped unless the docker class is on and a
 * GitHub token that can read the CodeGlo repos is present. Connect that
 * token to the workspace before running this; the test does not put the
 * token in the chat transcript.
 *
 *   E2E_DOCKER_CLASS=1 E2E_ODIN_GITHUB_TOKEN=... \
 *   E2E_TARGET_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts odin-docker-stack
 */
const enabled = process.env.E2E_DOCKER_CLASS === "1" && !!process.env.E2E_ODIN_GITHUB_TOKEN

test.describe("odin docker-class stack", () => {
  test.skip(
    !enabled,
    "Set E2E_DOCKER_CLASS=1 and E2E_ODIN_GITHUB_TOKEN. Do not run this until the staging docker class is on.",
  )

  test("port 8000 preview serves the Odin signup page", async ({ page }) => {
    test.setTimeout(30 * 60_000)
    const user = makeTestUser("OdinStack")
    await signUpAndOnboard(page, user)
    await createProjectAndWait(
      page,
      [
        "Switch this project to the docker-compose stack.",
        "Clone https://github.com/CodeGlo/alignment-project-server branch dev into the workspace.",
        "GitHub is already connected; do not ask for a token and do not print credentials.",
        "Run `make shogo-up`. When it is healthy, publish port 8000 as the preview and stop.",
      ].join(" "),
    )
    await sendChatMessage(page, "If shogo-up is not finished, finish it and publish port 8000.")
    await waitForAgentIdle(page, 25 * 60_000)

    const projectId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()
    expect(projectId).toBeTruthy()

    const ports = await page.request.get(`/api/projects/${projectId}/ports`)
    expect(ports.ok()).toBe(true)
    const body = await ports.json()
    const preview = (body.ports as Array<{ port: number; previewUrl?: string }>).find((p) => p.port === 8000)
    expect(preview?.previewUrl).toContain(`8000--${projectId}`)

    const app = await page.request.get(preview!.previewUrl!)
    expect(app.ok()).toBe(true)
    expect(await app.text()).toMatch(/sign up|get started|odin/i)
  })
})

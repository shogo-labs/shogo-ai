// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page } from "@playwright/test"
import { makeTestUser, signUpAndOnboard } from "./helpers"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

/**
 * Chat File Upload E2E Tests
 *
 * Validates that:
 *   1. Files uploaded via the chat input are saved to the agent's filesystem
 *   2. The LLM can see/describe uploaded images (vision works)
 *
 * Run: STAGING_URL=https://studio-staging.shogo.ai npx playwright test --config e2e/playwright.config.ts chat-file-upload
 */

const TEST_USER = makeTestUser("FileUpload")

function createTestImage(filename: string): string {
  const tmpDir = os.tmpdir()
  const filePath = path.join(tmpDir, filename)
  // 2x2 red PNG — small but valid enough for vision to identify the color
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==",
    "base64"
  )
  fs.writeFileSync(filePath, pngBytes)
  return filePath
}

function createTestTextFile(filename: string, content: string): string {
  const tmpDir = os.tmpdir()
  const filePath = path.join(tmpDir, filename)
  fs.writeFileSync(filePath, content, "utf-8")
  return filePath
}

async function createProjectAndWait(page: Page, prompt: string) {
  await page.goto("/")
  await page.waitForSelector("text=What's on your mind", { timeout: 15_000 })

  const input = page.getByPlaceholder("Ask Shogo to create...")
  await input.click()
  await input.fill(prompt)
  await page.waitForTimeout(500)
  await page.keyboard.press("Enter")

  await page.waitForURL(/\/projects\//, { timeout: 60_000 })

  // Wait for agent to finish its initial response
  await page
    .waitForSelector('[aria-label="Stop"], [aria-label="stop"]', {
      state: "detached",
      timeout: 90_000,
    })
    .catch(() => {})
  await page.waitForTimeout(1000)
}

async function sendChatMessage(page: Page, text: string) {
  const chatInput = page.getByPlaceholder("Ask Shogo...")
  await chatInput.click()
  await chatInput.fill(text)
  await page.waitForTimeout(300)
  await page.keyboard.press("Enter")
}

async function waitForAgentResponse(page: Page) {
  await page
    .waitForSelector('[aria-label="Stop"], [aria-label="stop"]', {
      state: "detached",
      timeout: 90_000,
    })
    .catch(() => {})
  await page.waitForTimeout(1000)
}

async function uploadFileViaChat(page: Page, filePath: string) {
  // Playwright's setInputFiles triggers the hidden file input's change event
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(filePath)
  await page.waitForTimeout(1000)
}

async function waitForFilePreview(page: Page, filename: string, isImage: boolean) {
  if (isImage) {
    // Image files show as a thumbnail with a remove button, no filename text.
    // Wait for the preview container (has an img inside it) to appear.
    await expect(page.locator('img[src^="data:image"]').first()).toBeVisible({ timeout: 5_000 })
  } else {
    await expect(page.getByText(filename)).toBeVisible({ timeout: 5_000 })
  }
}

test.describe("Chat File Upload", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test("create a project for file upload testing", async () => {
    await createProjectAndWait(page, "Simple test agent for file uploads")
    expect(page.url()).toMatch(/\/projects\//)
  })

  test("uploaded text file appears in agent filesystem", async () => {
    const testContent = `Name,Score\nAlice,95\nBob,87\nCharlie,72`
    const filePath = createTestTextFile("test-scores.csv", testContent)

    await uploadFileViaChat(page, filePath)
    await waitForFilePreview(page, "test-scores.csv", false)

    await sendChatMessage(page, "I uploaded a CSV file. Can you read it from the files directory and tell me Alice's score?")
    await waitForAgentResponse(page)

    // The agent should be able to read the file from the filesystem and report the score
    await expect(
      page.getByText("95").last()
    ).toBeVisible({ timeout: 10_000 })

    fs.unlinkSync(filePath)
  })

  test("uploaded image is visible to the LLM via vision", async () => {
    const filePath = createTestImage("red-square.png")

    await uploadFileViaChat(page, filePath)
    await waitForFilePreview(page, "red-square.png", true)

    await sendChatMessage(page, "What color is this image? Reply with just the color name, nothing else.")
    await waitForAgentResponse(page)

    // The LLM should be able to identify the red color via vision
    await expect(
      page.getByText(/red/i).last()
    ).toBeVisible({ timeout: 10_000 })

    fs.unlinkSync(filePath)
  })

  test("uploaded file is saved with its original name on the agent filesystem", async () => {
    // The CSV test above proves the filename is preserved: the agent's read_file
    // tool call targets "files/test-scores.csv" (original name, not auto-generated).
    // Verify this by asking the agent to confirm the filename it read.
    await sendChatMessage(page, "What was the exact filename of the CSV file you read earlier?")
    await waitForAgentResponse(page)

    await expect(
      page.getByText("test-scores.csv").last()
    ).toBeVisible({ timeout: 10_000 })
  })
})

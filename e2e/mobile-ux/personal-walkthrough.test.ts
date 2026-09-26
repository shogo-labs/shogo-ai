// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const API_BASE =
  process.env.E2E_API_URL ||
  process.env.STAGING_API_URL ||
  "http://localhost:8010";

type WorkspaceRow = { id: string; kind?: string; name?: string };

async function establishLocalPersonalSession(
  page: Page,
): Promise<WorkspaceRow> {
  await page.goto("/");
  await page.evaluate(async (apiBase) => {
    await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
    await fetch(`${apiBase}/api/onboarding/complete`, {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
  }, API_BASE);

  const personal = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/api/workspaces`, {
      credentials: "include",
    });
    const body = await response.json();
    const workspaces = (body?.items ??
      body?.data?.items ??
      []) as WorkspaceRow[];
    return (
      workspaces.find((workspace) => workspace.kind === "personal") ?? null
    );
  }, API_BASE);

  expect(
    personal,
    "local mode must expose a personal workspace",
  ).not.toBeNull();
  return personal!;
}

async function capture(page: Page, testInfo: TestInfo, step: string) {
  const safeStep = step.replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "");
  await page.screenshot({
    path: testInfo.outputPath(`walkthrough-${safeStep}.png`),
    fullPage: true,
  });
}

async function openPersonalHome(page: Page, workspace: WorkspaceRow) {
  await page.addInitScript((activeWorkspace) => {
    localStorage.setItem("shogo:active-workspace-id", activeWorkspace.id);
    localStorage.setItem(
      "shogo:active-workspace-kind",
      JSON.stringify({ id: activeWorkspace.id, kind: "personal" }),
    );
  }, workspace);
  await page.goto("/(app)");
  await expect(
    page.getByRole("button", { name: "Open chat sessions" }),
  ).toBeVisible();
}

test.describe("personal agent mobile UX walkthrough", () => {
  test("walks the mobile personal-agent surfaces and captures each state", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const workspace = await establishLocalPersonalSession(page);
    await openPersonalHome(page, workspace);

    await capture(page, testInfo, "01-personal-home");

    await page.getByRole("button", { name: "Open chat sessions" }).click();
    await expect(
      page.getByRole("button", { name: "Close chat drawer" }),
    ).toBeVisible();
    await capture(page, testInfo, "02-chat-drawer");

    // The personal drawer should contain chat navigation, but never team
    // project navigation. This catches the unconditional Projects section in
    // the mobile shell without depending on a project fixture.
    await expect(page.getByText("Projects", { exact: true })).toHaveCount(0);

    const shogoHome = page.getByRole("button", { name: "Shogo Home" });
    await expect(shogoHome).toBeVisible();
    await shogoHome.click();
    await expect(page).toHaveURL(/\/(?:\(app\)|$)/);
    await capture(page, testInfo, "03-shogo-home");

    await page.goto("/activity");
    await expect(
      page.getByText("Activity", { exact: true }).last(),
    ).toBeVisible();
    await capture(page, testInfo, "04-activity");

    await page.goto("/goals");
    await expect(page.getByText("Goals", { exact: true }).last()).toBeVisible();
    await capture(page, testInfo, "05-goals");

    await page.goto("/notifications");
    await expect(
      page.getByText("Notifications", { exact: true }).last(),
    ).toBeVisible();
    await capture(page, testInfo, "06-notifications");

    await page.goto("/settings");
    await expect(
      page.getByText("Settings", { exact: true }).last(),
    ).toBeVisible();
    await capture(page, testInfo, "07-settings");

    await page.goto("/(app)");
    const composer = page
      .getByTestId("project-composer-input")
      .or(page.getByTestId("home-composer-input"))
      .or(page.getByRole("textbox", { name: /ask shogo|message/i }))
      .first();
    await expect(composer).toBeVisible();
    await composer.fill("example.com");
    await capture(page, testInfo, "08-composer-filled");
    await expect(composer).toHaveValue("example.com");
  });
});

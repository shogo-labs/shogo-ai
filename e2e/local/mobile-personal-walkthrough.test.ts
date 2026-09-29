// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { expect, test, type Page } from "@playwright/test";

const API_BASE =
  process.env.E2E_API_URL ||
  process.env.STAGING_API_URL ||
  "http://localhost:8010";

type WorkspaceRow = { id: string; kind?: string; name?: string };

async function establishLocalPersonalSession(
  page: Page,
): Promise<WorkspaceRow> {
  await page.goto("/");
  const onboarding = await page.evaluate(async (apiBase) => {
    const signIn = await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    });
    if (!signIn.ok) {
      throw new Error(
        `Local auto-sign-in failed (${signIn.status}): ${await signIn.text()}`,
      );
    }

    const onboardingResponse = await fetch(`${apiBase}/api/onboarding/complete`, {
      method: "POST",
      credentials: "include",
    });
    return {
      ok: onboardingResponse.ok,
      status: onboardingResponse.status,
    };
  }, API_BASE);
  if (!onboarding.ok) {
    console.warn(
      `Local onboarding completion returned HTTP ${onboarding.status}; continuing to inspect the workspace.`,
    );
  }

  const personal = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/api/workspaces`, {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(
        `Loading workspaces failed (${response.status}): ${await response.text()}`,
      );
    }
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

function homeComposer(page: Page) {
  return page
    .getByTestId("project-composer-input")
    .or(page.getByTestId("home-composer-input"))
    .or(page.getByRole("textbox", { name: /ask shogo|message/i }))
    .first();
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
  test("walks the mobile personal-agent surfaces", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const workspace = await establishLocalPersonalSession(page);
    await openPersonalHome(page, workspace);

    await page.getByRole("button", { name: "Open chat sessions" }).click();
    await expect(
      page.getByRole("button", { name: "Close chat drawer" }),
    ).toBeVisible();
    await expect(page.getByText("Side chats", { exact: true })).toBeVisible();

    // The personal drawer should contain chat navigation, but never team
    // project navigation. This catches the unconditional Projects section in
    // the mobile shell without depending on a project fixture.
    await expect(page.getByText("Projects", { exact: true })).toHaveCount(0);

    const shogoHome = page.getByRole("button", { name: "Shogo Home" });
    await expect(shogoHome).toBeVisible();
    await shogoHome.click();
    await expect(homeComposer(page)).toBeVisible();

    await page.goto("/activity");
    await expect(
      page.getByText("Activity", { exact: true }).last(),
    ).toBeVisible();

    await page.goto("/goals");
    await expect(page.getByText("Goals", { exact: true }).last()).toBeVisible();

    await page.goto("/notifications");
    await expect(
      page.getByText("Notifications", { exact: true }).last(),
    ).toBeVisible();

    await page.goto("/settings");
    await expect(
      page.getByText("Settings", { exact: true }).last(),
    ).toBeVisible();

    await page.goto("/(app)");
    const composer = homeComposer(page);
    await expect(composer).toBeVisible();
    await composer.fill("example.com");
    await expect(composer).toHaveValue("example.com");
    await expect(page.getByText("Ask Shogo...", { exact: true })).toHaveCount(0);
  });

  test("marks all existing notifications read", async ({ page }) => {
    test.setTimeout(180_000);
    const workspace = await establishLocalPersonalSession(page);
    await openPersonalHome(page, workspace);
    await page.goto("/notifications");

    const markAllRead = page.getByRole("button", { name: "Mark all as read" });
    const hasUnread = await markAllRead.isVisible().catch(() => false);
    test.skip(!hasUnread, "local inbox has no unread notifications");

    await markAllRead.click();
    await expect(markAllRead).toBeHidden();
  });
});

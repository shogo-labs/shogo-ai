// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone drawer lists workspace chats by activity, not by id (SHO-56).
 *
 * `MobileWorkspaceShell` used `String(b.id).localeCompare(String(a.id))` as a
 * stand-in for "stable", so the `Chats` section rendered shuffled while each
 * row showed a relative timestamp. The three chats this spec creates get
 * `lastActiveAt` values in the exact reverse of their id order, so an id sort
 * and an activity sort cannot agree: on `origin/main` the rows come out oldest
 * first, on the fix the newest chat is on top.
 *
 * The timestamps are written straight into the stack's SQLite file (the pattern
 * in `chat-paused-wake-churn.test.ts`) so the order does not depend on how long
 * three chat turns happen to take. `updatedAt` is deliberately set to "now" on
 * every row: the relative label must come from `lastActiveAt` too, otherwise
 * every row would read "just now".
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts workspace-chat-order --project chromium
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "fs";
import { resolve } from "path";
import { DatabaseSync } from "node:sqlite";

type WorkspaceRow = { id: string; kind?: string; name?: string };

const API =
  process.env.E2E_API_URL ||
  process.env.STAGING_API_URL ||
  "http://localhost:8002";
const REPO_ROOT = resolve(__dirname, "../..");

function localDbPath(): string | null {
  if (process.env.E2E_LOCAL_DB) return process.env.E2E_LOCAL_DB;
  const bundled = resolve(REPO_ROOT, "test-results/e2e-local.db");
  // E2E_LOCAL_START_STACK boots the API against this file; an inherited
  // DATABASE_URL from an agent shell would point at a different database.
  if (process.env.E2E_LOCAL_START_STACK === "1") return bundled;
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv?.startsWith("file:")) return fromEnv.slice("file:".length);
  return existsSync(bundled) ? bundled : null;
}

const DB_PATH = localDbPath();

test.skip(!DB_PATH, "no local SQLite database to inspect (set E2E_LOCAL_DB)");
test.setTimeout(300_000);

/** Prisma writes SQLite DateTime as ISO text with a `+00:00` offset. */
function prismaDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

async function establishLocalPersonalSession(
  page: Page,
): Promise<WorkspaceRow> {
  await page.goto("/");
  await page.evaluate(async (apiBase) => {
    const signIn = await fetch(`${apiBase}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    });
    if (!signIn.ok) {
      throw new Error(
        `Local auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`,
      );
    }
    await fetch(`${apiBase}/api/onboarding/complete`, {
      method: "POST",
      credentials: "include",
    });
  }, API);

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
    const workspaces = (body?.items ?? body?.data?.items ?? []) as WorkspaceRow[];
    return workspaces.find((workspace) => workspace.kind === "personal") ?? null;
  }, API);

  expect(
    personal,
    "local mode must expose a personal workspace",
  ).not.toBeNull();
  return personal!;
}

/** The chat rows the drawer renders, in DOM order. */
async function renderedChatLabels(page: Page): Promise<string[]> {
  const labels = await page
    .getByLabel(/^Chat: /)
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
  return labels.map((label) => label.slice("Chat: ".length));
}

let workspaceId = "";
let db: DatabaseSync;
/** Sessions this run created, deleted again in `afterAll`. */
const cleanupSessions: string[] = [];

test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext({
    baseURL: String(info.project.use.baseURL),
  });
  const page = await context.newPage();
  const workspace = await establishLocalPersonalSession(page);
  workspaceId = workspace.id;
  await context.close();
  db = new DatabaseSync(DB_PATH!, { readOnly: false });
});

test.afterAll(() => {
  if (db) {
    for (const sessionId of cleanupSessions) {
      db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(sessionId);
    }
  }
  db?.close();
});

test("the drawer lists workspace chats newest activity first", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const workspace = await establishLocalPersonalSession(page);
  expect(workspace.id).toBe(workspaceId);

  // Unique per attempt, so a retry never sees the previous run's rows.
  const prefix = `SHO-56 ${Date.now()}`;
  const created: Array<{ id: string; name: string }> = [];
  for (const suffix of ["A", "B", "C"]) {
    const response = await page.request.post(
      `${API}/api/workspaces/${workspaceId}/sessions`,
      { data: { name: `${prefix} ${suffix}` } },
    );
    expect(response.status()).toBe(201);
    const body = await response.json();
    created.push({ id: body.session.id, name: body.session.name });
    cleanupSessions.push(body.session.id);
  }

  // Give the list its activity in the reverse of the order an id sort would
  // produce, so the two orders can never agree by accident.
  const idDesc = [...created].sort((a, b) => b.id.localeCompare(a.id));
  const activityOrder = [...idDesc].reverse();
  // 62 / 182 / 362 minutes sit two minutes past their relative-time boundary,
  // so the rendered label cannot drift while the drawer opens.
  const offsetsMinutes = [62, 182, 362];
  const expectedLabels = ["1h ago", "3h ago", "6h ago"];
  const now = Date.now();
  activityOrder.forEach((row, index) => {
    const activeAt = new Date(now - offsetsMinutes[index] * 60_000);
    db.prepare(
      "UPDATE chat_sessions SET lastActiveAt = ?, updatedAt = ? WHERE id = ?",
    ).run(prismaDate(activeAt), prismaDate(new Date(now)), row.id);
  });

  await page.addInitScript((activeWorkspace: WorkspaceRow) => {
    localStorage.setItem("shogo:active-workspace-id", activeWorkspace.id);
    localStorage.setItem(
      "shogo:active-workspace-kind",
      JSON.stringify({ id: activeWorkspace.id, kind: "personal" }),
    );
  }, workspace);
  await page.goto("/(app)");

  await page.getByRole("button", { name: "Open chat sessions" }).click();
  await expect(page.getByText("Chats", { exact: true })).toBeVisible();

  const expectedOrder = activityOrder.map((row) => row.name);
  const ourRows = (labels: string[]) =>
    labels.filter((label) => label.startsWith(prefix));
  await expect
    .poll(async () => ourRows(await renderedChatLabels(page)))
    .toEqual(expectedOrder);

  // The label reads from the same fact the list is sorted by, not `updatedAt`
  // (which is "now" on every row).
  for (const [index, row] of activityOrder.entries()) {
    await expect(
      page.getByLabel(`Chat: ${row.name}`, { exact: true }),
    ).toContainText(expectedLabels[index]);
  }

  // A chat created from the drawer belongs at the top of the same list.
  await page.getByRole("button", { name: "New chat" }).click();
  await page.waitForURL(/chatSessionId=/);
  const createdHere = new URL(page.url()).searchParams.get("chatSessionId");
  if (createdHere) cleanupSessions.push(createdHere);

  await page.getByRole("button", { name: "Open chat sessions" }).click();
  // The created chat sits above the chats that were last active hours ago.
  await expect
    .poll(async () => {
      const labels = await renderedChatLabels(page);
      const createdIndex = labels.indexOf("Workspace chat");
      const olderIndexes = expectedOrder.map((name) => labels.indexOf(name));
      return (
        createdIndex >= 0 &&
        olderIndexes.every((index) => index >= 0) &&
        createdIndex < Math.min(...olderIndexes)
      );
    })
    .toBe(true);
});

test("pinned chats lead and the archived group is activity-ordered too", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const workspace = await establishLocalPersonalSession(page);
  expect(workspace.id).toBe(workspaceId);

  const prefix = `SHO-56P ${Date.now()}`;
  const created: Array<{ id: string; name: string }> = [];
  for (const suffix of ["D", "E", "F", "G"]) {
    const response = await page.request.post(
      `${API}/api/workspaces/${workspaceId}/sessions`,
      { data: { name: `${prefix} ${suffix}` } },
    );
    expect(response.status()).toBe(201);
    const body = await response.json();
    created.push({ id: body.session.id, name: body.session.name });
    cleanupSessions.push(body.session.id);
  }

  // Activity is the exact reverse of the id order, so an id sort and an activity
  // sort cannot agree: newest activity goes to the smallest id. The least recent
  // chat is pinned (it must still lead), the most recent stays unpinned, and the
  // two middle chats are archived, where activity order must hold again.
  const idAsc = [...created].sort((a, b) => a.id.localeCompare(b.id));
  const [newest, archivedNewer, archivedOlder, pinnedOldest] = idAsc;
  const rows = [
    { row: pinnedOldest, minutes: 362, pinned: true, archived: false },
    { row: newest, minutes: 62, pinned: false, archived: false },
    { row: archivedNewer, minutes: 122, pinned: false, archived: true },
    { row: archivedOlder, minutes: 182, pinned: false, archived: true },
  ];
  const now = Date.now();
  for (const { row, minutes, pinned, archived } of rows) {
    db.prepare(
      "UPDATE chat_sessions SET lastActiveAt = ?, updatedAt = ?, isPinned = ?, isArchived = ? WHERE id = ?",
    ).run(
      prismaDate(new Date(now - minutes * 60_000)),
      prismaDate(new Date(now)),
      pinned ? 1 : 0,
      archived ? 1 : 0,
      row.id,
    );
  }

  await page.addInitScript((activeWorkspace: WorkspaceRow) => {
    localStorage.setItem("shogo:active-workspace-id", activeWorkspace.id);
    localStorage.setItem(
      "shogo:active-workspace-kind",
      JSON.stringify({ id: activeWorkspace.id, kind: "personal" }),
    );
  }, workspace);
  await page.goto("/(app)");

  await page.getByRole("button", { name: "Open chat sessions" }).click();
  await expect(page.getByText("Chats", { exact: true })).toBeVisible();

  const ourRows = (labels: string[]) =>
    labels.filter((label) => label.startsWith(prefix));
  await expect
    .poll(async () => ourRows(await renderedChatLabels(page)))
    .toEqual([pinnedOldest.name, newest.name]);

  await page
    .getByRole("button", { name: "Expand archived side chats" })
    .click();
  await expect
    .poll(async () => ourRows(await renderedChatLabels(page)))
    .toEqual([
      pinnedOldest.name,
      newest.name,
      archivedNewer.name,
      archivedOlder.name,
    ]);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-530 — the Home panel's workspace chat list grows as the sidebar scrolls.
 *
 * Russell: "workspace chats shouldn't have a show 5 more, it should be infinite
 * scroll." `WorkspaceChatsPanel` now hands `ChatSessionList` `paging="infinite"`,
 * which draws no Show more / Show less / See all row at all and takes 30 more
 * rows each time AppSidebar's panel scroll view comes within 200px of its end
 * (`SidebarScrollContext`).
 *
 * The RTL tests fire that signal by hand, so this is the spec that proves the
 * real scroll view feeds it in a browser:
 *   1. the Home list has no paging row of any kind, and the oldest seeded chat
 *      is not drawn on first paint (the list is windowed, not everything);
 *   2. scrolling the panel to its end draws the rest **once each**, newest
 *      first, and still no paging row appears at the bottom.
 *
 * Chats are seeded through `/api/workspaces/:id/sessions` and deleted again in
 * `afterAll` (and any a crashed run left behind in `beforeAll`): 65 extra rows
 * would otherwise bury another spec's chats behind the same window.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts sidebar-chat-infinite-scroll --project chromium
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "fs";
import { resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_API_BASE } from "./helpers";
import { signIn } from "./team-nav-seed";

test.setTimeout(300_000);

/** Rows this spec seeds. Two pages plus the remainder of a third. */
const SEEDED = 65;
/** `ChatSessionList` draws this many before any scroll. */
const FIRST_PAGE = 30;
/** Names of every chat this spec creates, so leftovers never go unnoticed. */
const NAME_PREFIX = "SHO-530 scroll";

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

const pad = (index: number) => String(index).padStart(2, "0");
/** `SHO-530 scroll 07` — the name index is its age, newest is the largest. */
const chatName = (index: number) => `${NAME_PREFIX} ${pad(index)}`;

async function localSignIn(page: Page): Promise<void> {
  await page.request
    .post(`${LOCAL_API_BASE}/api/local/auto-sign-in`)
    .catch(() => undefined);
  await page.request
    .post(`${LOCAL_API_BASE}/api/onboarding/complete`)
    .catch(() => undefined);
  await signIn(page);
}

/** The sidebar's workspace chat list. */
function chatsPanel(page: Page) {
  return page.getByTestId("workspace-chats-panel");
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`);
  const json = await res.json();
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{
    id: string;
    kind?: string;
  }>;
  const id = items.find((w) => w.kind === "personal")?.id;
  if (!id) {
    throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`);
  }
  return id;
}

async function createChat(
  page: Page,
  workspaceId: string,
  name: string,
): Promise<string> {
  const response = await page.request.post(
    `${LOCAL_API_BASE}/api/workspaces/${workspaceId}/sessions`,
    { data: { name } },
  );
  expect(response.status(), `POST /sessions for ${name}`).toBe(201);
  const body = await response.json();
  return body.session.id as string;
}

/** The `Chat: <name>` labels this spec's chats have drawn, in DOM order. */
async function seededChatLabels(page: Page): Promise<string[]> {
  const labels = await chatsPanel(page)
    .getByLabel(/^Chat: /)
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
  return labels
    .filter((label) => label.startsWith(`Chat: ${NAME_PREFIX}`))
    .map((label) => label.slice("Chat: ".length));
}

/**
 * Put the panel's scroll view at its end and report how many of this spec's
 * rows are drawn afterwards.
 *
 * The panel is a `View` inside AppSidebar's one `ScrollView`, so the scroller
 * is an ancestor, not the node itself: walk up to the first one that can
 * scroll. Assigning `scrollTop` past the current maximum is what a user's
 * scroll to the bottom does — and because every grown page makes the maximum
 * larger, each pass moves the offset and fires the scroll event the list is
 * listening for.
 */
async function scrollPanelToEnd(page: Page): Promise<number> {
  return chatsPanel(page).evaluate((node, prefix) => {
    let scroller: HTMLElement | null = node as HTMLElement;
    while (
      scroller &&
      scroller.scrollHeight <= scroller.clientHeight + 2
    ) {
      scroller = scroller.parentElement;
    }
    if (!scroller) {
      throw new Error("the chats panel has no scrollable ancestor to scroll");
    }
    scroller.scrollTop = scroller.scrollHeight;
    return Array.from(document.querySelectorAll('[aria-label^="Chat: "]'))
      .map((element) => element.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith(`Chat: ${prefix}`)).length;
  }, NAME_PREFIX);
}

let db: DatabaseSync;

test.beforeAll(() => {
  db = new DatabaseSync(DB_PATH!, { readOnly: false });
  db.prepare(`DELETE FROM chat_sessions WHERE name LIKE '${NAME_PREFIX} %'`).run();
});

test.afterAll(() => {
  if (!db) return;
  db.prepare(`DELETE FROM chat_sessions WHERE name LIKE '${NAME_PREFIX} %'`).run();
  db.close();
});

test.describe("workspace chats grow on the sidebar's scroll (local)", () => {
  // Deliberately short: 30 rows cannot fill this window, so the first page
  // overflows it and the "not everything is drawn yet" claim below is about
  // the window, not about how tall a row happens to be. (On a window tall
  // enough that a page does not fill it, the list is expected to fill itself
  // without a scroll — AC3 — and this spec would prove nothing about paging.)
  test.use({ viewport: { width: 1440, height: 640 } });

  test("no Show more row, and scrolling the panel to its end draws every chat once", async ({
    page,
  }) => {
    await localSignIn(page);
    const workspaceId = await personalWorkspaceId(page);
    for (let index = 1; index <= SEEDED; index += 1) {
      await createChat(page, workspaceId, chatName(index));
    }

    await page.goto("/");
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 });
    // The newest chat is the first row; wait for the list to be live.
    await expect(
      chatsPanel(page).getByLabel(`Chat: ${chatName(SEEDED)}`, { exact: true }),
    ).toBeVisible({ timeout: 90_000 });

    // AC1 — the Home list offers no way to page: no Show more, no Show less,
    // no "See all (n)" anywhere in the panel.
    await expect(chatsPanel(page).getByLabel(/Show more chats/)).toHaveCount(0);
    await expect(chatsPanel(page).getByLabel(/Show fewer chats/)).toHaveCount(0);
    await expect(chatsPanel(page).getByLabel(/See all chats/)).toHaveCount(0);
    await expect(chatsPanel(page).getByText("Show more", { exact: true })).toHaveCount(0);
    await expect(chatsPanel(page).getByText("Show less", { exact: true })).toHaveCount(0);
    await expect(chatsPanel(page).getByText(/^See all/)).toHaveCount(0);

    // Windowed: the first page at least, never the whole list.
    const firstPaint = (await seededChatLabels(page)).length;
    expect(
      firstPaint,
      `the list drew ${firstPaint} rows before any scroll; the first page is ${FIRST_PAGE}`,
    ).toBeGreaterThanOrEqual(FIRST_PAGE);
    expect(
      firstPaint,
      `all ${SEEDED} rows were drawn before any scroll — the list is not windowed`,
    ).toBeLessThan(SEEDED);
    // The oldest chat is past the window, so it is not on screen yet.
    await expect(
      chatsPanel(page).getByLabel(`Chat: ${chatName(1)}`, { exact: true }),
    ).toHaveCount(0);

    // AC2 — each scroll-end draws the next page, in order, until all of them.
    let drawn = firstPaint;
    for (let attempt = 0; attempt < 8 && drawn < SEEDED; attempt += 1) {
      await scrollPanelToEnd(page);
      await expect
        .poll(async () => (await seededChatLabels(page)).length, {
          timeout: 20_000,
          message: `scroll-end #${attempt + 1} drew no further rows (still ${drawn} of ${SEEDED})`,
        })
        .toBeGreaterThan(drawn);
      drawn = (await seededChatLabels(page)).length;
    }

    const labels = await seededChatLabels(page);
    expect(
      labels,
      "every seeded chat is drawn once the panel is scrolled through",
    ).toHaveLength(SEEDED);
    expect(new Set(labels).size, "no chat is drawn twice").toBe(SEEDED);
    expect(labels[0], "newest first").toBe(chatName(SEEDED));
    expect(labels[labels.length - 1], "oldest last").toBe(chatName(1));
    // `sortSideChats` order, not insertion order: two chats created in the same
    // millisecond may swap, so this allows a tie and fails on a real reorder.
    const indexes = labels.map((label) => Number(label.slice(-2)));
    expect(indexes).toEqual([...indexes].sort((a, b) => b - a));

    // The end of the list is the end: still no paging row to press.
    await expect(chatsPanel(page).getByLabel(/See all chats/)).toHaveCount(0);
    await expect(chatsPanel(page).getByLabel(/Show more chats/)).toHaveCount(0);
    await expect(chatsPanel(page).getByText(/^See all/)).toHaveCount(0);
  });
});

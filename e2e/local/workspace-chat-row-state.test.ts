// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-190 — what a workspace chat row says about a turn, end to end.
 *
 * Russell's report: the sidebar / phone-drawer chat list had no spinner on a
 * running chat, the row's time only moved when the agent finished, and pinning
 * showed nothing. The list keeps its own rows (not the MST collection), so it
 * only ever learned "running" from the screen that was on screen, at send time
 * nothing re-stamped the row, and `ChatTreeItem`'s leading slot could not show
 * a pin at all.
 *
 * Three cases:
 *   1. AC1/AC2 — send in chat A, leave it for chat B, and A keeps spinning off
 *      the server's `active-chats` answer (nothing local is left to tell the
 *      list, and the blank emit a chat switch sends must not clear it); when the
 *      server stops reporting the turn the row gets the unread dot, which the
 *      open clears. A is pinned throughout, so the same pass proves
 *      spinner › unread › pin.
 *   2. AC4 — a send re-stamps the row to "just now" and lifts it above a newer
 *      chat *before* the reply lands, with no list re-fetch; a reload then
 *      agrees with the server.
 *   3. AC5 — pin shows in the sidebar pane and in the phone drawer, unpin
 *      removes it on the click, and a pinned row that is running shows the
 *      spinner instead.
 *
 * `GET /api/workspaces/:id/active-chats` is mocked so the spec — not a model —
 * decides when a turn ends, and the chat POST is held open where a turn has to
 * stay running. Rows are found by their `Chat: <name>` label, the same handle
 * `workspace-chat-order.test.ts` uses.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts workspace-chat-row-state --project chromium
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { existsSync } from "fs";
import { resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_API_BASE } from "./helpers";
import { signIn } from "./team-nav-seed";

test.setTimeout(300_000);

/**
 * A stack booted from an empty database has not onboarded the local user yet.
 * Both calls are no-ops once that has happened.
 */
async function localSignIn(page: Page): Promise<void> {
  await page.request
    .post(`${LOCAL_API_BASE}/api/local/auto-sign-in`)
    .catch(() => undefined);
  await page.request
    .post(`${LOCAL_API_BASE}/api/onboarding/complete`)
    .catch(() => undefined);
  await signIn(page);
}

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

/** Prisma writes SQLite DateTime as ISO text with a `+00:00` offset. */
function prismaDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

type Turn = { chatSessionId: string; startedAt: string };

/** chatsPanel — the sidebar's workspace chat list. */
function chatsPanel(page: Page) {
  return page.getByTestId("workspace-chats-panel");
}

/**
 * Reveal the rows the panel keeps behind "Show more" — it renders five at a
 * time, so a chat seeded as three hours old sits below the fold.
 */
async function expandChats(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const more = chatsPanel(page).getByLabel(/^Show more chats for/).first();
    if ((await more.count()) === 0 || !(await more.isVisible())) return;
    // The list re-renders as rows page in; a click that lands mid-render is not
    // an error, the next pass sees the button again.
    await more.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
  }
}

/** One row, by the label `ChatTreeItem` gives it. */
function chatRow(page: Page, name: string) {
  return chatsPanel(page).getByLabel(`Chat: ${name}`, { exact: true });
}

/** The workspace agent's composer. */
function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first();
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`);
  const json = await res.json();
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>;
  const id = items.find((w) => w.kind === "personal")?.id;
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`);
  return id;
}

async function createChat(
  page: Page,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await page.request.post(
    `${LOCAL_API_BASE}/api/workspaces/${workspaceId}/sessions`,
    { data: { name } },
  );
  expect(response.status()).toBe(201);
  const body = await response.json();
  return { id: body.session.id, name: body.session.name ?? name };
}

/** The rows this spec created, in DOM order. */
async function renderedChatLabels(page: Page): Promise<string[]> {
  const labels = await chatsPanel(page)
    .getByLabel(/^Chat: /)
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
  return labels.map((label) => label.slice("Chat: ".length));
}

/**
 * Whether `before` is rendered above `after` among the rows carrying `prefix`.
 * Relative on purpose: other chats — the primary one, rows another spec left,
 * a reload that pages the list — may legitimately sit between or below them, so
 * an exact list would fail on data the test does not own.
 */
async function rowAbove(
  page: Page,
  prefix: string,
  before: string,
  after: string,
): Promise<boolean> {
  const labels = (await renderedChatLabels(page)).filter((label) => label.startsWith(prefix));
  const at = labels.indexOf(before);
  return at >= 0 && (labels.indexOf(after) === -1 || at < labels.indexOf(after));
}

/**
 * Answer the activity poll with whatever the spec says is running. This is the
 * server's own "a turn is live" answer (`listActiveChatTurns`), which is the
 * only thing that can tell a list about a turn the screen is not watching.
 */
async function mockActiveChats(page: Page, running: Turn[]): Promise<void> {
  await page.route("**/api/workspaces/*/active-chats", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ chats: running }),
    });
  });
}

/** Hold the next workspace chat turn open until `release()` is called. */
async function holdNextTurn(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = () => resolveGate();
  });
  const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;
  const body = [
    frame({ type: "start", messageId: "msg_sho190_e2e" }),
    frame({ type: "start-step" }),
    frame({ type: "text-start", id: "text_sho190_e2e" }),
    frame({ type: "text-delta", id: "text_sho190_e2e", delta: "Working on it." }),
    frame({ type: "text-end", id: "text_sho190_e2e" }),
    frame({ type: "finish-step" }),
    frame({ type: "finish" }),
  ].join("");
  await page.route("**/api/workspaces/*/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    // Held open: the reply never reaches the page until the spec says so.
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body,
    });
  });
  // The live-turn probe the composer runs before sending.
  await page.route("**/api/workspaces/*/chat/*/turn", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    });
  });
  return release;
}

/**
 * Flip a row's pin from its own menu. Waits first for any session-list refresh
 * already in flight to land: `refresh()` replaces the whole list, so a response
 * that started before the click would repaint the old value over the new one.
 */
async function togglePin(page: Page, name: string, action: "Pin" | "Unpin"): Promise<void> {
  await page.waitForTimeout(1_500);
  await chatsPanel(page).getByLabel(`Manage ${name}`).click();
  await page.getByRole("menuitem", { name: action }).click();
}

/** The server's own `isPinned` for one chat, so a test never trusts the paint. */
async function serverPinned(
  page: Page,
  workspaceId: string,
  sessionId: string,
): Promise<boolean | undefined> {
  const res = await page.request.get(
    `${LOCAL_API_BASE}/api/workspaces/${workspaceId}/sessions`,
  );
  const body = await res.json();
  const rows = (body?.sessions ?? []) as Array<{ id: string; isPinned?: boolean }>;
  return rows.find((row) => row.id === sessionId)?.isPinned;
}

/**
 * Watch one row for `ms`, sampling whether it shows `label`. Used for the
 * invariant a single end-state assertion cannot prove: a spinner must not blink
 * out at any point, and a dot must not appear at any point.
 */
async function sampleRowLabel(
  page: Page,
  name: string,
  label: string,
  ms: number,
): Promise<{ samples: number; seen: number }> {
  await page.evaluate(
    ({ name, label }) => {
      const w = window as unknown as {
        __sho190Samples: boolean[];
        __sho190Sampler: ReturnType<typeof setInterval>;
      };
      w.__sho190Samples = [];
      w.__sho190Sampler = setInterval(() => {
        const row = Array.from(document.querySelectorAll("[aria-label]")).find(
          (element) => element.getAttribute("aria-label") === `Chat: ${name}`,
        );
        w.__sho190Samples.push(
          Boolean(row?.querySelector(`[aria-label="${label}"]`)),
        );
      }, 150);
    },
    { name, label },
  );
  await page.waitForTimeout(ms);
  const samples = await page.evaluate(() => {
    const w = window as unknown as {
      __sho190Samples: boolean[];
      __sho190Sampler: ReturnType<typeof setInterval>;
    };
    clearInterval(w.__sho190Sampler);
    return w.__sho190Samples ?? [];
  });
  return { samples: samples.length, seen: samples.filter(Boolean).length };
}

type LiftSample = { names: string[]; justNow: boolean };

/**
 * Sample the panel in-page every 50ms: the prefix-filtered row order, and
 * whether `name` reads "just now". The refresh a send triggers can repaint the
 * row from the server a moment later, so the lift has to be caught as it
 * happens rather than asserted once the dust settles.
 */
async function startLiftSampler(page: Page, prefix: string, name: string): Promise<void> {
  await page.evaluate(
    ({ prefix, name }) => {
      const w = window as unknown as {
        __sho190Lift: LiftSample[];
        __sho190LiftTimer: ReturnType<typeof setInterval>;
      };
      w.__sho190Lift = [];
      w.__sho190LiftTimer = setInterval(() => {
        const panel = document.querySelector('[data-testid="workspace-chats-panel"]');
        if (!panel) return;
        const rows = Array.from(panel.querySelectorAll('[aria-label^="Chat: "]'));
        const names = rows
          .map((row) => row.getAttribute("aria-label") ?? "")
          .map((label) => label.slice("Chat: ".length))
          .filter((label) => label.startsWith(prefix));
        const target = rows.find(
          (row) => row.getAttribute("aria-label") === `Chat: ${name}`,
        );
        w.__sho190Lift.push({
          names,
          justNow: /just now/.test(target?.textContent ?? ""),
        });
      }, 50);
    },
    { prefix, name },
  );
}

async function readLiftSampler(page: Page): Promise<LiftSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __sho190Lift: LiftSample[];
      __sho190LiftTimer: ReturnType<typeof setInterval>;
    };
    clearInterval(w.__sho190LiftTimer);
    return w.__sho190Lift ?? [];
  });
}

let db: DatabaseSync;
/** Sessions this run created, deleted again in `afterAll`. */
const cleanupSessions: string[] = [];

test.beforeAll(() => {
  db = new DatabaseSync(DB_PATH!, { readOnly: false });
  // Rows an earlier run of this spec left behind (a crashed run never reaches
  // `afterAll`) would bury the chats these tests seed behind "Show more": the
  // panel only renders a handful at a time.
  db.prepare("DELETE FROM chat_sessions WHERE name LIKE 'SHO-190 %'").run();
});

test.afterAll(() => {
  if (!db) return;
  for (const sessionId of cleanupSessions) {
    db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(sessionId);
  }
  db.close();
});

test.describe("workspace chat row state (local)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a chat you leave keeps spinning, then flags the unread dot", async ({ page }) => {
    await localSignIn(page);
    const workspaceId = await personalWorkspaceId(page);
    const prefix = `SHO-190 spin ${Date.now()}`;
    const chatA = await createChat(page, workspaceId, `${prefix} A`);
    const chatB = await createChat(page, workspaceId, `${prefix} B`);
    cleanupSessions.push(chatA.id, chatB.id);
    // A is pinned: its pin is what the running / unread states have to beat.
    db.prepare("UPDATE chat_sessions SET isPinned = 1 WHERE id = ?").run(chatA.id);

    const running: Turn[] = [];
    await mockActiveChats(page, running);
    await holdNextTurn(page);
    await page.goto("/");
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 });

    // Beside a pinned row, an idle unread-free row shows the pin.
    await expect(chatRow(page, chatA.name).getByLabel("Pinned").first()).toBeVisible({
      timeout: 30_000,
    });

    // Send in A. The turn runs; the row's leading slot is the spinner, not the pin.
    await chatRow(page, chatA.name).click();
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    await composer(page).click();
    await composer(page).fill(`${prefix} prompt`);
    await page.keyboard.press("Enter");
    await expect(chatRow(page, chatA.name).getByLabel("Chat running").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(chatRow(page, chatA.name).getByLabel("Pinned").first()).toHaveCount(0);

    // The server now reports the turn too — that is what keeps the row spinning
    // once the screen that published it is gone.
    running.push({ chatSessionId: chatA.id, startedAt: new Date().toISOString() });

    // Leave A for B. The screen publishes a blank activity emit on the switch;
    // it must not clear a spinner the server still reports.
    await chatRow(page, chatB.name).click();
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    const kept = await sampleRowLabel(page, chatA.name, "Chat running", 7_000);
    expect(kept.samples, "the sampler never ran").toBeGreaterThan(20);
    expect(
      kept.seen,
      `A's spinner blinked out ${kept.samples - kept.seen}/${kept.samples} samples after leaving it`,
    ).toBe(kept.samples);

    // The server stops reporting it: that is the turn ending.
    running.length = 0;
    await expect(chatRow(page, chatA.name).getByLabel("Chat has new activity").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(chatRow(page, chatA.name).getByLabel("Chat running").first()).toHaveCount(0);
    // B never ran and is not unread.
    await expect(chatRow(page, chatB.name).getByLabel("Chat running").first()).toHaveCount(0);
    await expect(chatRow(page, chatB.name).getByLabel("Chat has new activity").first()).toHaveCount(0);

    // Opening A reads it: the dot goes, the pin is back.
    await chatRow(page, chatA.name).click();
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    await expect(chatRow(page, chatA.name).getByLabel("Chat has new activity").first()).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(chatRow(page, chatA.name).getByLabel("Pinned").first()).toBeVisible({ timeout: 15_000 });
  });

  test("a send moves the row's time to now and lifts it, before the reply", async ({ page }) => {
    await localSignIn(page);
    const workspaceId = await personalWorkspaceId(page);
    const prefix = `SHO-190 time ${Date.now()}`;
    const older = await createChat(page, workspaceId, `${prefix} older`);
    const newer = await createChat(page, workspaceId, `${prefix} newer`);
    cleanupSessions.push(older.id, newer.id);

    // `updatedAt` is "now" on both: only `lastActiveAt` can produce the label.
    const now = Date.now();
    db.prepare(
      "UPDATE chat_sessions SET lastActiveAt = ?, updatedAt = ? WHERE id = ?",
    ).run(prismaDate(new Date(now - 3 * 3_600_000)), prismaDate(new Date(now)), older.id);
    db.prepare(
      "UPDATE chat_sessions SET lastActiveAt = ?, updatedAt = ? WHERE id = ?",
    ).run(prismaDate(new Date(now - 3_600_000)), prismaDate(new Date(now)), newer.id);

    await mockActiveChats(page, []);
    await page.goto("/");
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 });
    await expandChats(page);

    // The starting order is by activity: the newer chat sits above the older one,
    // which says three hours ago.
    await expect.poll(async () => rowAbove(page, prefix, newer.name, older.name)).toBe(true);
    await expect(chatRow(page, older.name)).toContainText("3h ago");

    // Send in the older chat. Sampled inside the page rather than asserted after
    // the fact: the lift lands in the frame the send returns, and the session
    // list refresh ~2s behind it repaints the row from the server.
    await chatRow(page, older.name).click();
    await expect(composer(page)).toBeVisible({ timeout: 60_000 });
    await composer(page).click();
    await composer(page).fill(`${prefix} prompt`);

    await startLiftSampler(page, prefix, older.name);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    const samples = await readLiftSampler(page);
    const lifted = samples.filter(
      (sample) => sample.names[0] === older.name && sample.justNow,
    );
    expect(samples.length, "the sampler never ran").toBeGreaterThan(20);
    expect(
      lifted.length,
      `the send never re-stamped and lifted the row (${JSON.stringify(samples.slice(0, 3))})`,
    ).toBeGreaterThan(0);

    // The list refresh the send kicked off has landed by now, and it repaints
    // from the server — so the last sample proves the database moved too, not
    // just the client (a client-only bump snapped back here before section B).
    const settled = samples[samples.length - 1];
    expect(
      settled.justNow && settled.names[0] === older.name,
      `the row fell back after the list refresh (${JSON.stringify(settled)})`,
    ).toBe(true);

    // And it survives a reload, which reads the session list from scratch: the
    // desktop track now bumps `lastActiveAt` at insert (`localChatMessageHooks`),
    // the same function the cloud hook uses.
    await page.reload();
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 });
    await expect(chatRow(page, older.name)).toContainText(/just now/);
    await expect
      .poll(
        async () => {
          await expandChats(page);
          return rowAbove(page, prefix, older.name, newer.name);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("pin shows in the pane and the phone drawer, and unpin clears it", async ({ page }) => {
    await localSignIn(page);
    const workspaceId = await personalWorkspaceId(page);
    const prefix = `SHO-190 pin ${Date.now()}`;
    const pinned = await createChat(page, workspaceId, `${prefix} target`);
    const other = await createChat(page, workspaceId, `${prefix} other`);
    cleanupSessions.push(pinned.id, other.id);

    await mockActiveChats(page, []);
    await page.goto("/");
    await expect(chatsPanel(page)).toBeVisible({ timeout: 90_000 });
    await expect(chatRow(page, pinned.name)).toBeVisible({ timeout: 30_000 });
    await expect(chatRow(page, pinned.name).getByLabel("Pinned").first()).toHaveCount(0);

    // Pin from the row's own menu: the icon flips on the click, no reload.
    await togglePin(page, pinned.name, "Pin");
    await expect(chatRow(page, pinned.name).getByLabel("Pinned").first()).toBeVisible({
      timeout: 15_000,
    });
    // A pinned row leads the list.
    await expect
      .poll(async () =>
        (await renderedChatLabels(page)).filter((label) => label.startsWith(prefix))[0],
      )
      .toBe(pinned.name);
    // And the server kept it: the icon is not a purely optimistic paint.
    await expect
      .poll(async () => (await serverPinned(page, workspaceId, pinned.id)), {
        message: "the pin reached the server",
      })
      .toBe(true);

    // Unpin is just as immediate.
    await togglePin(page, pinned.name, "Unpin");
    await expect(chatRow(page, pinned.name).getByLabel("Pinned").first()).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await serverPinned(page, workspaceId, pinned.id)), {
        message: "the unpin reached the server",
      })
      .toBe(false);

    // Pin it again, then look at the phone drawer's rows — the same fact, on the
    // surface that used to hide it (`ChatTreeItem` gated the pin on `!comfortable`).
    await togglePin(page, pinned.name, "Pin");
    await expect(chatRow(page, pinned.name).getByLabel("Pinned").first()).toBeVisible({
      timeout: 15_000,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open chat sessions" }).click();
    await expect(page.getByText("Chats", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByLabel(`Chat: ${pinned.name}`, { exact: true }).getByLabel("Pinned").first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByLabel(`Chat: ${other.name}`, { exact: true }).getByLabel("Pinned").first(),
    ).toHaveCount(0);
  });
});

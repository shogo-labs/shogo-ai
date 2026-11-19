// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A send posts the message, not the transcript (SHO-402).
 *
 * Every chat send used to POST all the messages the client had loaded — with
 * tool calls and tool outputs — which measured ~800 KB at the median and 26 MB
 * at the top end. On a slow uplink that is seconds of upload before the server
 * sees anything, and the turn's save only happens once the whole body arrives,
 * so a send looked like it never went.
 *
 * The runtime reads only the newest user message and seeds a cold session from
 * the `historySeed` the API attaches, so the client now sends just the turn
 * being sent. This spec holds the transcript in the panel the way a real chat
 * does (a mocked 25-turn history with tool output, ~700 KB) and asserts on the
 * request the composer actually puts on the wire:
 *
 *  1. `messages.length === 1`, and it is the message that was typed;
 *  2. the whole body is under 10 KB;
 *  3. the transcript really was loaded, so (1) and (2) are not the trivial case
 *     of a chat with no history.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts chat-send-body-size
 */
import { expect, test, type Page } from "@playwright/test"
import { openTeamHome } from "./helpers"

// This spec has its own CI job (`E2E (chat send body size)` in ci.yml) because
// the shards never reached it inside their cap. Running it inside a shard as
// well only doubles the cost — and, when it flakes, doubles the red on a job
// that already reports it (SHO-447). The shard step sets `E2E_SHARD`; the
// dedicated entry does not.
test.skip(
  Boolean(process.env.E2E_SHARD),
  "has its own CI job (E2E (chat send body size)); it does not also run inside a shard",
)

test.use({ video: "off", trace: "off" })

/** Turns in the fixture: well past a page, with tool output on every one. */
const TURN_COUNT = Number(process.env.E2E_BODY_SIZE_TURNS || 25)
/** The card's budget for a text-only send, plus its turn fields. */
const BODY_BUDGET_BYTES = 10_000
/** The transcript the fixture holds is this big, so trimming it is the point. */
const TRANSCRIPT_FLOOR_BYTES = 500_000
const TAIL_MARKER = "body-size-tail-marker"
const SENT_TEXT = "what did I ask you two messages ago?"

const CHAT_POST_GLOB = "**/api/{projects,workspaces}/*/chat"
const TURN_GLOB = "**/api/{projects,workspaces}/*/chat/*/turn"
const STREAM_GLOB = "**/api/{projects,workspaces}/*/chat/*/stream*"
const MESSAGES_GLOB = "**/api/chat-messages**"

// ─── UI message stream (AI SDK `UIMessageChunk`s) ───────────────────────────

let frameCounter = 0
const sseFrame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`

function completedTurn(messageId: string, text: string): string {
  const textId = `${messageId}-t-${++frameCounter}`
  return [
    sseFrame({ type: "start", messageId }),
    sseFrame({ type: "start-step" }),
    sseFrame({ type: "text-start", id: textId }),
    sseFrame({ type: "text-delta", id: textId, delta: text }),
    sseFrame({ type: "text-end", id: textId }),
    sseFrame({ type: "finish-step" }),
    sseFrame({ type: "finish" }),
  ].join("")
}

// ─── The loaded transcript ──────────────────────────────────────────────────

/**
 * A tool output as it is stored: long enough that 25 turns is ~700 KB.
 *
 * 800 lines, not 260: at 260 the whole fixture serialised to ~255 KB, under the
 * `TRANSCRIPT_FLOOR_BYTES` the spec asserts on, so the precondition failed
 * before the send was ever measured.
 */
const toolOutput = (index: number) =>
  Array.from({ length: 800 }, (_, line) => `line ${line} of src/file-${index}.ts contents`).join("\n")

function savedRow(
  id: string,
  role: "user" | "assistant",
  parts: unknown[],
  createdAt: number,
): Record<string, unknown> {
  const content = parts.map((part) => (part as { text?: string }).text ?? "").join("\n")
  return {
    id,
    sessionId: "",
    role,
    content,
    parts: JSON.stringify(parts),
    createdAt,
    updatedAt: createdAt,
  }
}

function chatRows(turns: number): Array<Record<string, unknown>> {
  const base = Date.now() - turns * 120_000
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < turns; index++) {
    const tail = index === turns - 1 ? `\n\n${TAIL_MARKER}` : ""
    rows.push(
      savedRow(`u${index}`, "user", [{ type: "text", text: `question ${index}` }], base + index * 120_000),
      savedRow(
        `a${index}`,
        "assistant",
        [
          {
            type: "dynamic-tool",
            toolCallId: `call-${index}`,
            toolName: "read_file",
            state: "output-available",
            input: { path: `src/file-${index}.ts` },
            output: toolOutput(index),
          },
          { type: "text", text: `Reply ${index}${tail}` },
        ],
        base + index * 120_000 + 30_000,
      ),
    )
  }
  return rows
}

interface ChatState {
  rows: Array<Record<string, unknown>>
  /** Every chat POST body the composer actually sent, as text. */
  bodies: string[]
  /** The URL each of those bodies was sent to. */
  urls: string[]
}

/**
 * Serve the fixture history and answer every turn with a fixed stream, so no
 * model is called and the send is the only thing under test.
 */
async function installChat(page: Page, turns: number): Promise<ChatState> {
  const state: ChatState = { rows: chatRows(turns), bodies: [], urls: [] }
  let sessionId: string | null = null

  await page.route(CHAT_POST_GLOB, async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    sessionId = sessionId ?? route.request().headers()["x-chat-session-id"] ?? null
    state.bodies.push(route.request().postData() ?? "")
    state.urls.push(new URL(route.request().url()).pathname)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: completedTurn(`msg_${state.bodies.length}`, "That was two messages ago."),
    })
  })

  await page.route(TURN_GLOB, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed" }),
    })
  })

  await page.route(STREAM_GLOB, async (route) => {
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route(MESSAGES_GLOB, async (route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.continue()
    const url = new URL(request.url())
    const session = sessionId ?? url.searchParams.get("sessionId") ?? "session-under-test"
    const rows = state.rows.map((row) => ({ ...row, sessionId: session }))

    if (url.pathname.endsWith("/changes")) {
      const newest = rows.reduce(
        (cursor, row) => Math.max(cursor, Number((row as { updatedAt?: number }).updatedAt ?? 0)),
        0,
      )
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: [],
          total: rows.length,
          cursor: new Date(newest).toISOString(),
          reset: false,
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, items: [...rows].reverse(), total: rows.length }),
    })
  })

  return state
}

const projectComposer = (page: Page) => page.getByTestId("project-composer-input").first()

test.describe("a send carries the new message, not the loaded transcript", () => {
  // One client built one body for both typed-turn routes (`buildChatApiUrl` only
  // changes the URL). The UI here can only reach the workspace route — in local
  // mode a project panel chats against the merged-root workspace runtime — so
  // the project route's half of AC1 is asserted at the forwarded-body level in
  // `apps/api/src/__tests__/qa-sho402-one-message-turn.acceptance.test.ts`
  // (POST /api/projects/:id/chat → runtime `/agent/chat` with `historySeed`).
  test("the chat POST is a few KB and holds exactly one message", async ({ page }) => {
    test.setTimeout(300_000)
    const state = await installChat(page, TURN_COUNT)

    // The fixture is the thing that used to ride along on every send.
    expect(JSON.stringify(state.rows).length).toBeGreaterThan(TRANSCRIPT_FLOOR_BYTES)

    await openTeamHome(page)
    const home = page
      .getByTestId("home-composer-input")
      .or(page.getByRole("textbox", { name: "Describe the agent you want to build" }))
    await home.click()
    await home.fill("Build a body-size E2E project")
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/projects\//, { timeout: 60_000 })

    // The panel loaded the whole fixture: the newest turn is on screen.
    await expect(page.getByText(TAIL_MARKER, { exact: false }).first()).toBeVisible({
      timeout: 90_000,
    })
    await projectComposer(page).waitFor({ state: "visible", timeout: 30_000 })

    // Let the bootstrap turn settle, then send the message under test.
    await page.waitForTimeout(1_000)
    const before = state.bodies.length
    const composer = projectComposer(page)
    await composer.click()
    await composer.fill(SENT_TEXT)
    await page.keyboard.press("Enter")

    await expect
      .poll(() => state.bodies.length, { timeout: 30_000 })
      .toBeGreaterThan(before)
    const body = JSON.parse(state.bodies[state.bodies.length - 1]!) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
    }

    // Whichever typed-turn route this UI uses, it is one of the two the client
    // builds this same body for.
    expect(state.urls[state.urls.length - 1]).toMatch(
      /^\/api\/(workspaces|projects)\/[^/]+\/chat$/,
    )

    // AC1: one message, and it is the one that was typed.
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.role).toBe("user")
    expect(
      body.messages[0]!.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    ).toContain(SENT_TEXT)

    // AC1: the whole request stays small — the transcript did not ride along.
    const bytes = Buffer.byteLength(state.bodies[state.bodies.length - 1]!, "utf8")
    expect(
      bytes,
      `the send uploaded ${bytes} bytes; the loaded transcript is ${JSON.stringify(state.rows).length}`,
    ).toBeLessThan(BODY_BUDGET_BYTES)
  })
})

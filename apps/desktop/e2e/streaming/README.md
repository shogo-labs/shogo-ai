# Desktop streaming e2e

Drives the real dev desktop app (Electron + Metro renderer + local API) against a
scripted fake model, and checks that what the window shows is exactly what the model
sent, with bounded lag. It exists to reproduce streaming glitches, slowness and
stale views.

```sh
cd apps/desktop
npm run test:e2e:streaming                       # everything
npm run test:e2e:streaming -- -g "stop"          # a subset
SHOGO_E2E_REBUILD=1 npm run test:e2e:streaming   # rebuild dist/ first
```

Needs `bun run build:packages` at the repo root once, and `npm ci` in `apps/desktop`.
It starts its own Metro on a free port (set `SHOGO_E2E_DEV_URL` to reuse one),
uses a temporary Electron profile, and never touches your installed Shogo: the main
process skips its machine-wide `pkill`/port sweeps when `SHOGO_E2E=1`, and the harness
refuses to run if the app lands on a port that another process holds.

## How it works

- `fake-llm-server.ts`: an OpenAI-compatible server the local API is pointed at
  (`LOCAL_LLM_BASE_URL`). A marker in the user message scripts the reply:
  `long` (N numbered tokens), `hold` (wait for `release(tag)`), `tool` (text, then a
  `read_file` tool call, repeated for `rounds`, with an optional hold before a round).
  Tokens look like `t<tag>w0001`, so any view can be checked for gaps, repeats and
  reordering. It records when every token was written and when the app hung up.
- `stream-probe.ts`: samples the page every 40 ms and records which tokens are on
  screen, long tasks and frame gaps. Render lag is token send time vs first time visible.
- `desktop-app.ts`: launches everything, signs in, creates a project, and offers
  `send`, `leaveChat`/`returnToChat`, `reloadApp` and similar.
- `streaming.spec.ts`: the scenarios. Checks are soft, so one run lists every problem.

Reports (JSON, screenshots, `metro.log`) go to `test-results/streaming-e2e/`.

## Where lag comes from

Streaming scenarios split render lag into three stages, so a failure says which layer is slow:

- `server`: fake model -> a second reader on the resume stream (`/api/workspaces/:id/chat/:sid/stream`).
- `transport`: fake model -> the window's own response stream (the POST it sent). Read through a
  clone of `fetch`, installed before the app loads.
- `render`: the window's own stream -> text on screen.

The `several chats` scenario also reads each background chat's POST response with a bare loop
(`bareReaderLag`), which shows whether the delay needs the renderer at all.

Other chats are started through the API (`startBackgroundTurn`), not by clicking between chats,
because switching chats through the sidebar is not scriptable from the project window yet.

The fake model ends every reply with a usage chunk and varies tool inputs per round. Without the
first the agent reports "Agent produced no output"; without the second its loop detector stops the
turn after 4 identical calls.

## Budgets

Overridable with environment variables: `SHOGO_E2E_FIRST_TOKEN_MS` (1500),
`SHOGO_E2E_LAG_P95_MS` (250), `SHOGO_E2E_LAG_MAX_MS` (800), `SHOGO_E2E_LONG_TASK_MS` (250),
`SHOGO_E2E_SERVER_LAG_P95_MS` (150), `SHOGO_E2E_RENDERER_LAG_P95_MS` (150), `SHOGO_E2E_CHATS` (5),
`SHOGO_E2E_TOOL_CALLS` (60), `SHOGO_E2E_STOP_MS` (2000), `SHOGO_E2E_CATCH_UP_MS` (1500), `SHOGO_E2E_GROWTH_TURNS` (6),
`SHOGO_E2E_GROWTH_FACTOR` (2).

## Not covered yet

The island and a second window as observers of the same chat (see the island sync plan), and
switching between chats through the sidebar.

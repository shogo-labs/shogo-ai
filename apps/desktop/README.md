# Shogo Desktop (Local Mode)

Shogo Desktop is the offline-first, open-source edition of Shogo. It runs the
full platform locally — no cloud account or subscription required.

License: `MIT`.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Electron Shell (apps/desktop)                  │
│  ┌───────────────┐  ┌────────────────────────┐  │
│  │ Expo Web Build │  │ Bun API Server (:8002) │  │
│  │  (shogo://)    │──│  SQLite + local FS     │  │
│  └───────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- **Frontend**: The same Expo/React Native web app used in the cloud, exported as
  static files and served via a custom `shogo://` protocol.
- **Backend**: The Hono API server running on Bun with SQLite (via
  `prisma-adapter-bun-sqlite`) instead of PostgreSQL, and local filesystem
  storage instead of S3.
- **Agent Runtime**: Spawned by the API server as a child process. Calls the AI
  proxy which forwards to your configured API keys (Anthropic/OpenAI).

## Prerequisites

- **Bun** >= 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js** >= 20 (for Expo CLI, Electron, **and Windows project sandbox
  dependency installs** — Bun 1.x has a hardlink bug on Windows that produces
  empty `node_modules`, so `RuntimeManager` shells out to `npm.cmd`. Shogo
  Desktop on Windows will not be able to run projects without Node.js
  installed at `C:\Program Files\nodejs\`.)
- The monorepo dependencies installed: `bun install` from the repo root

## Quick Start (Electron)

From the **repo root**:

```bash
bun run desktop:dev
```

This single command:

1. Generates the Prisma client for SQLite (`schema.local.prisma`)
2. Exports the Expo web build with `EXPO_PUBLIC_LOCAL_MODE=true`
3. Compiles the Electron TypeScript
4. Launches the Electron app, which starts the API server and opens the UI

On first launch, a default user (`local@shogo.local` / `shogo-local`) and
personal workspace are created automatically.

### Clean Start

To wipe all local data (database, workspaces, auth) and start fresh:

```bash
bun run desktop:dev:clean
```

## Browser Debugging (No Electron)

For faster iteration on the web UI, you can run the local backend and the Expo
dev server separately — no Electron required.

### 1. Push the SQLite schema

First time only (or after schema changes):

```bash
SHOGO_LOCAL_MODE=true \
DATABASE_URL="file:./shogo-local.db" \
  bun x prisma generate

SHOGO_LOCAL_MODE=true \
DATABASE_URL="file:./shogo-local.db" \
  bun x prisma db push --schema=prisma/schema.local.prisma
```

### 2. Start the API server in local mode

```bash
SHOGO_LOCAL_MODE=true \
DATABASE_URL="file:./shogo-local.db" \
BETTER_AUTH_SECRET=local-dev-secret \
BETTER_AUTH_URL=http://localhost:8002 \
NODE_ENV=development \
  bun apps/api/src/entry.ts
```

The server starts at `http://localhost:8002`. On first run it auto-seeds a
default user and workspace.

### 3. Start the Expo web dev server

In a second terminal:

```bash
cd apps/mobile

EXPO_PUBLIC_LOCAL_MODE=true \
EXPO_PUBLIC_API_URL=http://localhost:8002 \
  npx expo start --web --port 8081
```

Open **http://localhost:8081** in your browser.

## Configuring API Keys

Navigate to **Settings → API Keys** in the app. Keys are stored in the local
SQLite database and never leave your machine.

| Key              | Required | Purpose                              |
|------------------|----------|--------------------------------------|
| Anthropic API Key | Yes      | Powers the AI agent (Claude)        |
| OpenAI API Key    | Optional | Embeddings and alternative models   |

## Computer Control (Desktop-only MCP)

Shogo Desktop bundles [`computer-use-mcp`](https://github.com/domdomegg/computer-use-mcp)
as an opt-in MCP server. When enabled on an agent, the agent can move the mouse,
type on the keyboard, and take full-screen screenshots — i.e. drive arbitrary
GUI applications on your machine, not just a Playwright-controlled browser.

**Enabling it.** It is off by default. Toggle it on per agent via the agent's
MCP settings (catalog id `computer-use`, category *System & Desktop*). It is
hard-disabled in cloud sessions; the bundled package is only shipped with
desktop builds.

**Security.** With this enabled, the agent can do anything you can do at the
keyboard. The existing security tiers gate it:

- `strict`: every `computer(...)` call prompts you for approval
- `balanced`: prompts unless `computer` is on your auto-approve list
- `full_autonomy` (default): runs without prompting

We strongly recommend running in `strict` or `balanced` mode while a computer-
control agent is active. Adjust under **Settings → Security**.

**Platform notes.**

- **Windows**: works out of the box; no extra setup.
- **macOS**: the OS shows an Accessibility permission prompt the first time
  the agent tries to move the mouse or type. Approve under
  *System Settings → Privacy & Security → Accessibility* and add Shogo Desktop.
  Until you do, mouse/keyboard actions silently no-op.
- **Linux**: requires an X11 session. Under Wayland, the underlying nut.js
  bindings cannot send synthetic input; switch to an X11 session if you need
  computer control. The MCP automatically prefers `xdotool` for typing when
  available (handles non-US keyboard layouts).

## Update Channels

Shogo Desktop auto-updates via Electron's Squirrel-based `autoUpdater`. Every
install ships on the **Stable** channel by default; users can opt into
**Beta** from **Settings → Updates** to track the newest manually published
signed build instead of the latest tagged release.

| | Stable (default) | Beta (opt-in) |
|---|---|---|
| Tracks | Latest tagged `vX.Y.Z` release | Newest manually published build from the selected commit |
| Feed | `update.electronjs.org` (reads this repo's GitHub Releases; ignores prereleases/drafts by design) | `releases.shogo.ai/desktop/beta/...` — a Cloudflare Worker route that speaks the same protocol but includes prereleases |
| Version scheme | `X.Y.Z` | `<next patch>-beta.<UTC YYYYMMDDtHHMMSS>`, e.g. `1.14.10-beta.20260919t233000` |
| Stability | Recommended for everyday use | May be unstable — it's the manually selected commit |

Switching channels persists to `config.json` (`updateChannel`) and immediately
re-probes the new feed. Switching **Beta → Stable** does not downgrade — the
app keeps the currently-installed beta build until a stable release with a
higher version is published. The channel toggle is refused while a download
is in progress (`downloading`) or a downloaded update is waiting to install
(`ready`) — see the `set-update-channel` handler in `apps/desktop/src/updater.ts`.

Relevant source:
- `apps/desktop/src/update-channel.ts` — pure feed-URL resolver (channel + platform + arch + version → feed URL), unit-tested in `apps/desktop/test-update-channel.ts`.
- `apps/desktop/src/updater.ts` — probes the feed, owns the `get/set-update-channel`, `check-for-updates`, `download-update`, `install-update` IPC handlers.
- `apps/mobile/components/settings/UpdatesTab.tsx` / `apps/mobile/components/UpdateBanner.tsx` — the channel selector and the in-app update banner (shows a "Beta" tag when on the beta channel).
- `terraform/modules/install-shogo-ai/scripts/releases-worker.js.tftpl` — the `/desktop/<channel>/<platform>-<arch>/<version>[/RELEASES]` Worker route beta rides on, tested in `releases-worker.test.ts`.

### Testing update channels

- **Unit**: `bun test-update-channel.ts` (feed URL resolution), plus the
  Worker route tests (`bun test terraform/modules/install-shogo-ai/scripts/releases-worker.test.ts`)
  and the beta-version script tests (`bun test scripts/__tests__/desktop-next-beta-version.test.ts`).
- **E2E (Playwright-Electron)**: `apps/desktop/e2e/update-channel.spec.ts` boots
  the real Electron app against a local mock feed server (via
  `SHOGO_UPDATE_FEED_BASE_URL` + `SHOGO_UPDATER_E2E=1`) and drives the real
  `window.shogoDesktop` update-channel IPC surface — channel switch, banner
  render, `config.json` persistence, and persistence across a relaunch:
  ```bash
  cd apps/desktop
  npm run build   # or: npx tsc && npm run bundle:main
  PLAYWRIGHT_E2E=1 npx playwright test --config e2e/playwright.config.ts e2e/update-channel.spec.ts
  ```
  It does not exercise a real Squirrel download/install (that needs a signed
  build — see the beta dry-run procedure in `BUILD.md`).
- **Deployed-feed smoke test**: `./scripts/check-desktop-feed.sh` hits the
  live `releases.shogo.ai` Worker and checks the beta route's up-to-date /
  update-available / `RELEASES`-rewrite responses, plus parity between the
  stable route and `update.electronjs.org` for the same inputs. Run after any
  Terraform apply that touches `releases-worker.js.tftpl`.

## What's Different in Local Mode

| Feature             | Cloud                      | Local                           |
|---------------------|----------------------------|---------------------------------|
| Database            | PostgreSQL                 | SQLite (via bun:sqlite)         |
| File storage        | S3 / MinIO                 | Local filesystem                |
| Auth                | Better Auth + Google OAuth | Better Auth (email/password)    |
| Billing / Usage     | Stripe integration         | Disabled — bring your own keys  |
| Agent runtime       | Kubernetes / Knative pods  | Local child process             |
| Prisma schema       | `prisma/schema.prisma`     | `prisma/schema.local.prisma`    |

The platform config system (`apps/mobile/lib/platform-config.ts`) detects local
mode via `EXPO_PUBLIC_LOCAL_MODE=true` and hides billing, OAuth, admin, and
analytics UI.

## Environment Variables

### API Server (local mode)

| Variable               | Default                  | Description                          |
|------------------------|--------------------------|--------------------------------------|
| `SHOGO_LOCAL_MODE`     | —                        | Must be `true` to enable local mode  |
| `DATABASE_URL`         | `file:./shogo.db`        | SQLite database path                 |
| `BETTER_AUTH_SECRET`   | —                        | Auth session secret (any string)     |
| `BETTER_AUTH_URL`      | —                        | Auth base URL (`http://localhost:8002`) |
| `ANTHROPIC_API_KEY`    | —                        | Set via Settings UI or env           |
| `OPENAI_API_KEY`       | —                        | Set via Settings UI or env           |

### Expo Web Build

| Variable                  | Description                                 |
|---------------------------|---------------------------------------------|
| `EXPO_PUBLIC_LOCAL_MODE`  | `true` — activates local mode in the UI     |
| `EXPO_PUBLIC_API_URL`     | API server URL (e.g. `http://localhost:8002`)|

## Project Structure

```
apps/desktop/
├── src/
│   ├── main.ts           # Electron main process, window, protocol handler
│   ├── local-server.ts   # Spawns Bun API server, health checks, DB init
│   ├── paths.ts          # Resolves data dir, DB path, Bun binary, etc.
│   └── preload.ts        # Context bridge (exposes isDesktop flag)
├── forge.config.ts       # Electron Forge packaging config
├── package.json
└── tsconfig.json

prisma/
├── schema.prisma         # PostgreSQL schema (cloud)
└── schema.local.prisma   # SQLite schema (local/desktop)

prisma.config.ts          # Auto-selects schema based on SHOGO_LOCAL_MODE
prisma.config.local.ts    # Explicit local schema config
```

## Building for Distribution

```bash
cd apps/desktop
npm run package    # Create unpacked build
npm run make       # Create platform installers (.dmg, .exe)
```

The Electron Forge config (`forge.config.ts`) handles bundling the Bun binary,
API server, and web build into a self-contained application.

## Troubleshooting

**"The table `main.X` does not exist"**
Run `bun x prisma db push --schema=prisma/schema.local.prisma` with the correct
`DATABASE_URL` to create all tables.

**CORS errors in the browser**
Make sure both `EXPO_PUBLIC_LOCAL_MODE=true` and `EXPO_PUBLIC_API_URL` are set
when starting the Expo dev server. The API server allows `localhost` origins in
local mode.

**"Failed to fetch" on sign-up/sign-in**
Check that the API server is running on port 8002 and that
`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are set.

**Agent chat returns errors**
Verify your Anthropic API key is configured in Settings → API Keys. The agent
runtime requires a valid key to call the AI proxy.

# Shogo Desktop (Local Mode)

Shogo Desktop is the offline-first, open-source edition of Shogo. It runs the
full platform locally — no cloud account or subscription required.

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
- **Node.js** >= 18 (for Expo CLI and Electron)
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
PREWARM_CLAUDE_CODE=false \
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

## What's Different in Local Mode

| Feature             | Cloud                      | Local                           |
|---------------------|----------------------------|---------------------------------|
| Database            | PostgreSQL                 | SQLite (via bun:sqlite)         |
| File storage        | S3 / MinIO                 | Local filesystem                |
| Auth                | Better Auth + Google OAuth | Better Auth (email/password)    |
| Billing / Credits   | Stripe integration         | Disabled — bring your own keys  |
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
| `PREWARM_CLAUDE_CODE`  | `true`                   | Set `false` to disable Claude prewarm |
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

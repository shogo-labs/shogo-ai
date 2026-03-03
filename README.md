# Shogo AI

> AI-first agent builder. Build autonomous AI agents through conversation.

A platform for building personal AI agents that monitor systems, process messages across platforms, run scheduled tasks, remember context, and execute modular skills — all configured through natural language.

## Quick Start

### Local Development

**Prerequisites:**
- [Bun](https://bun.sh) — JavaScript runtime
- [Node.js](https://nodejs.org) — Required for npx/Expo CLI
- [Docker](https://www.docker.com/) — For infrastructure (Postgres, Redis, MinIO)

**1. Install dependencies and start infrastructure:**

```bash
bun install

# Start Docker infrastructure (Postgres, Redis, MinIO)
bun run docker:infra
```

**2. Run database migrations (first time only):**

```bash
bun run db:migrate:deploy
```

**3. Start all services:**

```bash
bun run dev:all
```

This starts three services concurrently:

| Service | Port | Description |
|---------|------|-------------|
| API Server | `localhost:8002` | Hono API, auth, chat proxy, agent runtimes |
| Web Frontend | `localhost:8081` | Expo web app (React Native for Web) |

Open **http://localhost:8081** in your browser.

Logs are written to `logs/api.log` and `logs/web.log` so you can `tail -f logs/api.log` to debug issues.

**Environment:** Copy `.env.local.template` to `.env.local` and fill in your API keys (at minimum `ANTHROPIC_API_KEY`). The dev server script will create a minimal `.env.local` for you if one doesn't exist.

#### Running Services Individually

If you prefer separate terminals:

```bash
bun run api:dev        # Terminal 1 — API server on :8002 (with --watch)
bun run web:dev        # Terminal 2 — Expo web on :8081
```

Or run just the backend (no frontend):

```bash
bun run dev:backend    # API only
```

#### Full Setup with Infrastructure

For a one-command start that also handles Docker and migrations:

```bash
bun run dev:start      # Starts Docker infra + app services
```

→ See [Getting Started](docs/GETTING_STARTED.md) and [Architecture](docs/ARCHITECTURE.md)

## Agent Templates

Shogo ships with 8 purpose-built agent templates:

| Template | Description |
|----------|-------------|
| Research Assistant | Web research, synthesis, canvas dashboards, daily briefings |
| GitHub Ops | PR triage, CI monitoring, issue tracking dashboards |
| Support Desk | Ticket triage, KPIs, Zendesk/Linear integration |
| Meeting Prep | Calendar events, attendee research, prep documents |
| Revenue Tracker | Revenue metrics, invoice management, Stripe integration |
| Project Board | Sprint board, task tracking, velocity metrics |
| Incident Commander | Service health monitoring, error correlation, alerting |
| Personal Assistant | Habit tracking, reminders, daily check-ins |

## Why Shogo AI?

| Traditional Approach | Shogo AI |
|---------------------|----------|
| Agents require heavy boilerplate | Templates + conversation-driven configuration |
| Manual integration wiring | Composio auto-bind for 250+ tools |
| No persistent state | Markdown memory + heartbeat scheduling |
| Isolated automations | Canvas dashboards with live data |

**Core differentiators:**
- **Conversation-first** — configure agents through chat, not code
- **Persistent memory** — agents remember context across sessions
- **Heartbeat system** — agents proactively check for work on a schedule
- **Canvas dashboards** — visual dashboards and summaries, not static text
- **Composio integrations** — connect GitHub, Slack, Stripe, and 250+ tools via OAuth

## Packages

| Package | Description |
|---------|-------------|
| [@shogo/state-api](packages/state-api) | Schema-to-MST transformation engine |
| [@shogo/agent-runtime](packages/agent-runtime) | Agent gateway, tools, Composio integrations |
| [@shogo/api](apps/api) | Hono API server, auth, chat proxy |
| [@shogo/mobile](apps/mobile) | Expo app (React Native for Web + iOS + Android) |

## Commands

### Development

| Command | Description |
|---------|-------------|
| `bun run dev:all` | Start API + Web concurrently |
| `bun run dev:backend` | Start API only (no frontend) |
| `bun run dev:start` | Full setup: Docker infra + app services |
| `bun run api:dev` | API server with hot reload (`:8002`) |
| `bun run web:dev` | Expo web frontend (`:8081`) |

### Infrastructure

| Command | Description |
|---------|-------------|
| `bun run docker:infra` | Start Postgres, Redis, MinIO containers |
| `bun run docker:infra:down` | Stop infrastructure containers |
| `bun run docker:infra:clean` | Stop and remove all volumes |
| `bun run db:migrate` | Run Prisma migrations (dev) |
| `bun run db:migrate:deploy` | Run Prisma migrations (deploy) |
| `bun run db:studio` | Open Prisma Studio |

### Build & Test

| Command | Description |
|---------|-------------|
| `bun install` | Install all dependencies |
| `bun run build` | Build all packages (Turbo) |
| `bun run test` | Run all tests |
| `bun run typecheck` | Type check all packages |
| `bun run lint` | Lint all packages |

## Documentation

### Guides
- [Getting Started](docs/GETTING_STARTED.md) — Developer setup
- [Architecture](docs/ARCHITECTURE.md) — System design and patterns

### Contributing
- [Contributing Guide](CONTRIBUTING.md) — How to contribute

## Project Structure

```
shogo-ai/
├── apps/
│   ├── api/               # Hono API server (auth, chat, runtime management)
│   └── mobile/            # Expo app (web + iOS + Android)
├── packages/
│   ├── state-api/         # Schema-to-MST transformation engine
│   ├── agent-runtime/     # Agent gateway, tool system, Composio
│   ├── shared-app/        # Shared app logic (auth, chat, domain)
│   └── domain-store/      # Domain CRUD stores
├── prisma/                # Database schema & migrations
├── scripts/               # Dev scripts (docker, codegen)
├── workspaces/            # Agent runtime workspaces (gitignored)
└── docs/                  # Documentation
```

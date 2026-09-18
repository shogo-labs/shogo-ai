# [Shogo AI](https://shogo.ai)

Shogo is an open-source platform for building AI agents that do real work:
reading from your systems, taking actions, and running workflows end to
end. TypeScript throughout. Self-host it or use Shogo Cloud.

**[Website](https://shogo.ai)** &middot; **[Launch Studio](https://studio.shogo.ai)** &middot; **[Documentation](https://shogo.ai/docs)**

Shogo combines a Hono API, Expo-based clients, agent runtimes, project
runtimes, and a developer SDK into one platform for building and operating
agentic products.

**License:** the SDK and client libraries you actually integrate
(`@shogo-ai/*`, plus the mobile/desktop clients) are MIT. The server
components behind Shogo Cloud (`apps/api/`, `packages/agent-runtime/`,
`packages/shared-runtime/`) are AGPL-3.0-or-later — a moat against hosted
resellers, not a restriction on your own use, modification, or
self-hosting. Full breakdown in [Open Source Model](#open-source-model)
below and [docs/LICENSING.md](./docs/LICENSING.md).

There's no one-command quickstart yet. Running Shogo locally means
cloning the repo, installing with Bun, starting Postgres/Redis/MinIO in
Docker, and running migrations — realistically a few minutes, not 60
seconds. The real steps are in [Local development](#local-development)
below.

<!-- coverage-badge:backend -->
[![Backend coverage](https://img.shields.io/badge/backend%20coverage-84.30%25-yellow)](./coverage/lcov.info)
<!-- /coverage-badge:backend -->
<!-- coverage-badge:frontend -->
[![Frontend coverage](https://img.shields.io/badge/frontend%20coverage-67.82%25-orange)](./coverage/frontend-lcov.info)
<!-- /coverage-badge:frontend -->

## What Shogo Is

You describe an agent in chat, and Shogo turns that description into a
long-lived process: it connects to your tools, reads from your systems,
takes actions, and checks in on a schedule via its heartbeat instead of
waiting to be asked. Results — dashboards, metrics, status — render on a
live canvas the agent builds for itself. Under the hood it's a Hono API
plus Expo-based clients, TypeScript throughout, aimed at engineering, ops,
and founder teams who want a working agent without assembling an
orchestration stack first.

## Key Features

- **Chat-configured agents** — identity, behavior rules, skills, and
  schedule live as Markdown workspace files (`AGENTS.md`, `SOUL.md`,
  `HEARTBEAT.md`, `skills/`) that the agent runtime reads and acts on
- **Heartbeat** — agents run proactively on a schedule, not only in
  response to a message: monitor repos, triage tickets, send digests
- **Integrations via Composio and MCP** — hundreds of tools (GitHub,
  Slack, Stripe, Linear, Sentry, and more) over OAuth or API keys
- **Channels** — connect and message through Slack, Telegram, and Discord
- **Canvas** — the agent builds and previews its own React dashboards and
  apps (metrics, charts, tables, status indicators) as it works
- **Per-agent capabilities** — toggle web search, browser control, shell,
  image generation, memory, channels, and integrations individually; each
  toggle gates both the tool and the related system-prompt guidance
- **Model router, memory, and checkpoints** — pluggable model routing,
  persistent memory, session persistence, and project checkpoints for
  recovering agent state
- **Multi-platform clients** — Expo-based web, iOS, Android, and desktop
  clients; an MIT-licensed `@shogo-ai/*` SDK; voice via ElevenLabs and
  Twilio

## How It Compares

- **vs. n8n / Activepieces** — those are visual workflow-automation
  tools with larger, more mature connector catalogs. Shogo has no visual
  flow editor; its unit is an agent that exercises judgment on a
  schedule, closer to n8n's intent than to an orchestration primitive,
  but earlier-stage and narrower in integration breadth.
- **vs. LangGraph / Dify / Flowise** — those are frameworks or builders
  for composing custom LLM pipelines with fine-grained control over
  orchestration. Shogo trades that flexibility for an opinionated runtime
  plus hosted product that gets you to a running agent faster.
- **vs. Retool / Appsmith** — those build internal tools by hand with a
  visual editor. Shogo generates canvas apps from an agent's own work,
  which is faster to a first result but gives you less direct control
  over the UI.
- **Honestly** — Shogo is materially less mature than any of the above,
  with a smaller community and no one-command quickstart yet (see
  [Local development](#local-development) below).

## Open Source Model

Shogo uses a split-license model. AGPL-3.0-or-later guards the
cloud-service surface a competitor would need to ship a hosted clone;
everything else is MIT so adoption is friction-free.

- AGPL-3.0-or-later: `apps/api/`, `apps/metal-agent/`,
  `packages/agent-runtime/`, `packages/canvas-runtime/`,
  `packages/shared-runtime/`
- MIT: the `@shogo-ai/*` libraries, `apps/mobile/`, `apps/desktop/`,
  `packages/shared-app/`, `packages/shared-ui/`, `packages/ui-kit/`,
  `packages/domain-stores/`
- Apache-2.0: `templates/runtime-template/`
- CC BY 4.0: `apps/docs/`, `docs/`
- Proprietary: `terraform/`, `k8s/`, `deploy-examples/`,
  `.github/workflows/` (see `INFRASTRUCTURE-LICENSE.md`)
- The hosted Shogo Cloud offering is proprietary

See [docs/LICENSING.md](./docs/LICENSING.md) for the full strategy and
rationale, plus `LICENSE`, `NOTICE`, `INFRASTRUCTURE-LICENSE.md`, and
`TRADEMARK.md`.

## Repository Layout

License is shown inline so the AGPL/MIT boundary is visible at a glance.

| Path | License | Purpose |
|------|---------|---------|
| `apps/api/` | AGPL | Hono API server, auth, billing, runtime orchestration |
| `apps/mobile/` | MIT | Expo app for web, iOS, and Android |
| `apps/desktop/` | MIT | Local desktop distribution |
| `apps/docs/` | CC BY 4.0 | Documentation site |
| `packages/sdk/` | MIT | Client SDK; back-compat shims for moved subpaths |
| `packages/core/` | MIT | Logger, OTEL instrumentation, stream-buffer, chat-message |
| `packages/agent/` | MIT | Agent loop, model router, hooks, pi-ai adapter |
| `packages/db/` | MIT | Prisma adapter helpers (PG / SQLite / libSQL) |
| `packages/email/` | MIT | Transactional email (SES / SMTP / OCI) |
| `packages/voice/` | MIT | ElevenLabs + Twilio voice infra; React + RN UI |
| `packages/cli/` | MIT | `validateManifest` / `runDeploy` / `pkg` helpers |
| `packages/shogo-worker/` | MIT | `shogo-worker` self-host CLI |
| `packages/model-catalog/` | MIT | Thin re-export shim (workspace-only) |
| `packages/agent-runtime/` | AGPL | Agent gateway, tools, integrations |
| `packages/canvas-runtime/` | AGPL | Canvas build/preview runtime |
| `packages/shared-runtime/` | AGPL | Server-side glue (s3-sync, server framework) |
| `packages/shared-app/` | MIT | Shared app/domain logic |
| `packages/shared-ui/` | MIT | Shared UI components |
| `packages/ui-kit/` | MIT | Theme and routing helpers |
| `packages/domain-stores/` | MIT | Domain store layer |
| `apps/metal-agent/` | AGPL | Bare-metal Firecracker microVM node agent |
| `templates/runtime-template/` | Apache-2.0 | Project template |

## Quick Start

### Local development

Prerequisites:

- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org)
- [Docker](https://www.docker.com/)

1. Install dependencies.

```bash
bun install
```

2. Create your local env file.

```bash
cp .env.example .env.local
```

3. Start local infrastructure.

```bash
bun run docker:infra
```

4. Run database migrations.

```bash
bun run db:migrate:deploy
```

5. Start the app.

```bash
bun run dev:all
```

Open `http://localhost:8081`.

## Self-Hosting

Shogo can be self-hosted locally or on your own infrastructure. For setup
details, required environment variables, storage, and deployment notes, see
`docs/SELF_HOSTING.md`.

Local desktop/offline usage is documented in `apps/desktop/README.md`.

## Packages

**Published to npm (MIT, lockstep release on the `sdk-v*` tag):**

| Package | Description |
|---------|-------------|
| `@shogo-ai/sdk` | Client SDK — auth, db client, LLM gateway, voice client |
| `@shogo-ai/core` | Logger, OTEL instrumentation, stream-buffer, chat-message |
| `@shogo-ai/agent` | Agent loop, model catalog/router, hooks, pi-ai adapter |
| `@shogo-ai/db` | Prisma adapter helpers (PG / SQLite / libSQL) |
| `@shogo-ai/email` | Transactional email — SES / SMTP / OCI |
| `@shogo-ai/voice` | ElevenLabs + Twilio voice; React + React Native UI |
| `@shogo-ai/cli` | `validateManifest` / `runDeploy` / `pkg` helpers |

Old `@shogo-ai/sdk/<subpath>` imports keep working through deprecated
re-export shims; see [`packages/sdk/MIGRATION.md`](./packages/sdk/MIGRATION.md).

**Workspace-only (AGPL):**

| Package | Description |
|---------|-------------|
| `@shogo/api` | API server and platform orchestration |
| `@shogo/agent-runtime` | Agent runtime and tool gateway |
| `@shogo/shared-runtime` | Server-side glue used only by the AGPL surface above |

**Workspace-only (MIT):**

| Package | Description |
|---------|-------------|
| `@shogo/mobile` | Primary client app |
| `shogo` | Desktop packaging layer |
| `@shogo/shared-app` | Shared app/domain logic |
| `@shogo/shared-ui` | Shared UI components |
| `@shogo/ui-kit` | Theme and routing helpers |
| `@shogo/domain-stores` | Domain store layer |

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev:all` | Start API and web app |
| `bun run dev:backend` | Start API only |
| `bun run docker:infra` | Start Postgres, Redis, and MinIO |
| `bun run db:migrate:deploy` | Apply migrations |
| `bun run build` | Build the monorepo |
| `bun run build:packages` | Build all 7 published `@shogo-ai/*` packages |
| `bun run build:sdk` / `:core` / `:agent` / `:db` / `:email` / `:voice` / `:cli` | Build a single package |
| `bun run test` | Run tests |
| `bun run typecheck` | Run TypeScript checks |
| `bun run lint` | Run linters |

## Links

- [Shogo AI Website](https://shogo.ai) -- learn about the platform
- [Shogo Studio](https://studio.shogo.ai) -- launch the web app
- [Pricing](https://shogo.ai/pricing) -- plans and features
- [Blog](https://shogo.ai/blog) -- updates and tutorials
- [Templates](https://shogo.ai/templates) -- pre-built agent templates
- [Integrations](https://shogo.ai/integrations) -- 250+ app connections

## Community

- `CONTRIBUTING.md` for contribution guidelines
- `CLA.md` for contributor licensing terms
- `SECURITY.md` for responsible disclosure
- `TRADEMARK.md` for branding and name usage

## Documentation

- [Getting Started](https://shogo.ai/docs) -- quickstart guide
- `docs/GETTING_STARTED.md`
- `docs/ARCHITECTURE.md`
- `docs/SELF_HOSTING.md`
- `packages/sdk/README.md`

# [Shogo AI](https://shogo.ai)

<!-- coverage-badge:backend -->
[![Backend coverage](https://img.shields.io/badge/backend%20coverage-58.26%25-orange)](./coverage/lcov.info)
<!-- /coverage-badge:backend -->
<!-- coverage-badge:frontend -->
[![Frontend coverage](https://img.shields.io/badge/frontend%20coverage-74.52%25-yellowgreen)](./coverage/frontend-lcov.info)
<!-- /coverage-badge:frontend -->

AI-first agent builder for chat-driven apps, persistent agents, and dynamic
workspaces.

**[Website](https://shogo.ai)** &middot; **[Launch Studio](https://studio.shogo.ai)** &middot; **[Documentation](https://shogo.ai/docs)**

Shogo combines a Hono API, Expo-based clients, agent runtimes, project
runtimes, and a developer SDK into one platform for building and operating
agentic products.

## Open Source Model

Shogo uses a split-license model:

- Core product code is licensed under `AGPL-3.0-or-later`
- `packages/{sdk,core,agent,db,email,voice,cli}/` and SDK
  examples are licensed under `MIT`
- Documentation is licensed under `CC BY 4.0`
- Infrastructure and deployment materials in `terraform/`, `k8s/`,
  `deploy-examples/`, and `.github/workflows/` are proprietary and licensed
  under `INFRASTRUCTURE-LICENSE.md`
- The hosted Shogo Cloud offering is proprietary

See `LICENSE`, `NOTICE`, `INFRASTRUCTURE-LICENSE.md`, and `TRADEMARK.md` for
details.

## Repository Layout

License is shown inline so the AGPL/MIT boundary is visible at a glance.

| Path | License | Purpose |
|------|---------|---------|
| `apps/api/` | AGPL | Hono API server, auth, billing, runtime orchestration |
| `apps/mobile/` | AGPL | Expo app for web, iOS, and Android |
| `apps/desktop/` | AGPL | Local desktop distribution |
| `apps/docs/` | AGPL | Documentation site |
| `packages/sdk/` | MIT | Client SDK; back-compat shims for moved subpaths |
| `packages/core/` | MIT | Logger, OTEL instrumentation, stream-buffer, chat-message |
| `packages/agent/` | MIT | Agent loop, model router, hooks, pi-ai adapter |
| `packages/db/` | MIT | Prisma adapter helpers (PG / SQLite / libSQL) |
| `packages/email/` | MIT | Transactional email (SES / SMTP / OCI) |
| `packages/voice/` | MIT | ElevenLabs + Twilio voice infra; React + RN UI |
| `packages/cli/` | MIT | `validateManifest` / `runDeploy` / `pkg` helpers |
| `packages/agent-runtime/` | AGPL | Agent gateway, tools, integrations |
| `packages/shared-runtime/` | AGPL | Shared runtime helpers |
| `packages/shared-app/` | AGPL | Shared app/domain logic |
| `packages/shared-ui/` | AGPL | Shared UI components |
| `packages/ui-kit/` | AGPL | Theme and routing helpers |
| `packages/domain-stores/` | AGPL | Domain store layer |
| `templates/runtime-template/` | MIT | Project template |

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
| `@shogo/mobile` | Primary client app |
| `shogo` | Desktop packaging layer |
| `@shogo/agent-runtime` | Agent runtime and tool gateway |

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
- [Integrations](https://shogo.ai/integrations) -- 970+ app connections

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

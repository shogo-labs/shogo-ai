# [Shogo AI](https://shogo.ai)

<!-- coverage-badge:backend -->
[![Backend coverage](https://img.shields.io/badge/backend%20coverage-76.0%25-yellowgreen)](./coverage/lcov.info)
<!-- /coverage-badge:backend -->
<!-- coverage-badge:frontend -->
[![Frontend coverage](https://img.shields.io/badge/frontend%20coverage-76.15%25-yellowgreen)](./coverage/frontend-lcov.info)
<!-- /coverage-badge:frontend -->

AI-first agent builder for chat-driven apps, persistent agents, and dynamic
workspaces.

**[Website](https://shogo.ai)** &middot; **[Launch Studio](https://studio.shogo.ai)** &middot; **[Documentation](https://shogo.ai/docs)**

Shogo combines a Hono API, Expo-based clients, agent runtimes, project
runtimes, and a developer SDK into one platform for building and operating
agentic products.

## Open Source Model

Shogo uses a split-license model. AGPL-3.0-or-later guards the
cloud-service surface a competitor would need to ship a hosted clone;
everything else is MIT so adoption is friction-free.

- AGPL-3.0-or-later: `apps/api/`, `packages/agent-runtime/`,
  `packages/shared-runtime/`
- MIT: the `@shogo-ai/*` libraries, `apps/mobile/`, `apps/desktop/`,
  `packages/shared-app/`, `packages/shared-ui/`, `packages/ui-kit/`,
  `packages/domain-stores/`, `templates/runtime-template/`
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
| `packages/shared-runtime/` | AGPL | Server-side glue (s3-sync, server framework) |
| `packages/shared-app/` | MIT | Shared app/domain logic |
| `packages/shared-ui/` | MIT | Shared UI components |
| `packages/ui-kit/` | MIT | Theme and routing helpers |
| `packages/domain-stores/` | MIT | Domain store layer |
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

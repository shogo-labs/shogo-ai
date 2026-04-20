# [Shogo AI](https://shogo.ai)

AI-first agent builder for chat-driven apps, persistent agents, and dynamic
workspaces.

**[Website](https://shogo.ai)** &middot; **[Launch Studio](https://studio.shogo.ai)** &middot; **[Documentation](https://shogo.ai/docs)**

Shogo combines a Hono API, Expo-based clients, agent runtimes, project
runtimes, and a developer SDK into one platform for building and operating
agentic products.

## Open Source Model

Shogo uses a split-license model:

- Core product code is licensed under `AGPL-3.0-or-later`
- `packages/sdk/` and SDK examples are licensed under `Apache-2.0`
- Documentation is licensed under `CC BY 4.0`
- Infrastructure and deployment materials in `terraform/`, `k8s/`,
  `deploy-examples/`, and `.github/workflows/` are proprietary and licensed
  under `INFRASTRUCTURE-LICENSE.md`
- The hosted Shogo Cloud offering is proprietary

See `LICENSE`, `NOTICE`, `INFRASTRUCTURE-LICENSE.md`, and `TRADEMARK.md` for
details.

## Repository Layout

| Path | Purpose |
|------|---------|
| `apps/api/` | Hono API server, auth, billing, runtime orchestration |
| `apps/mobile/` | Expo app for web, iOS, and Android |
| `apps/desktop/` | Local desktop distribution |
| `apps/docs/` | Documentation site |
| `packages/agent-runtime/` | Agent gateway, tools, integrations |
| `packages/shared-runtime/` | Shared runtime helpers |
| `packages/shared-app/` | Shared app/domain logic |
| `packages/shared-ui/` | Shared UI components |
| `packages/ui-kit/` | Theme and routing helpers |
| `packages/domain-stores/` | Domain store layer |
| `packages/sdk/` | Apache-licensed SDK |
| `templates/runtime-template/` | Apache-licensed project template |

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

| Package | Description |
|---------|-------------|
| `@shogo/api` | API server and platform orchestration |
| `@shogo/mobile` | Primary client app |
| `shogo` | Desktop packaging layer |
| `@shogo/agent-runtime` | Agent runtime and tool gateway |
| `@shogo-ai/sdk` | Developer SDK for auth, data, and email |

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev:all` | Start API and web app |
| `bun run dev:backend` | Start API only |
| `bun run docker:infra` | Start Postgres, Redis, and MinIO |
| `bun run db:migrate:deploy` | Apply migrations |
| `bun run build` | Build the monorepo |
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


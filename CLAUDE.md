# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Build all packages (uses Turbo for caching and topological ordering)
bun run build

# Run all tests
bun run test

# Type check all packages
bun run typecheck

# Lint all packages
bun run lint
```

### Running the Full Stack Locally

```bash
# 1. Start infrastructure (Postgres, Redis, MinIO) — requires Docker
bun run docker:infra

# 2. Run database migrations (first time or after schema changes)
bun run db:migrate:deploy

# 3. Start all services (API :8002, Web :8081)
bun run dev:all
```

Open **http://localhost:8081** to use the app. The API runs on `:8002`. Agent
runtimes are spawned by the API on ports starting at `:5200`.

Logs are written to `logs/api.log` and `logs/web.log`. To check service output
or debug issues:

```bash
tail -f logs/api.log          # API + agent runtime logs
grep '\[Composio\]' logs/api.log  # Filter for Composio integration logs
```

### Package-Specific Development

```bash
# Start all services concurrently (API + Expo Web)
bun run dev:all

# Start only backend (API, no frontend)
bun run dev:backend

# Individual services:
bun run web:dev        # Expo web on http://localhost:8081
bun run api:dev        # API server on http://localhost:8002 (with --watch)

# Mobile development:
bun run mobile:ios     # Expo iOS simulator
bun run mobile:android # Expo Android emulator
```

### Database Commands

```bash
# Start infrastructure (postgres, redis, minio)
bun run docker:infra

# Run Prisma migrations
bun run db:migrate

# Push schema changes to database
bun run db:push

# Open Prisma Studio
bun run db:studio

# Generate Prisma client
bun run db:generate
```

### Running Single Tests

```bash
# Run tests with pattern matching
bun test --filter "meta-store"

# Run tests in watch mode
bun test --watch
```

### E2E Tests

```bash
# SDK E2E tests
cd packages/sdk && bun run test:e2e
```

## Architecture Overview

### Package Dependency Graph

```
@shogo/api (Hono API server, Better Auth, Prisma)
├── @shogo/mobile (Universal Expo app - Web, iOS, Android)
│   ├── @shogo/shared-ui (Gluestack v3 universal components)
│   ├── @shogo/shared-app (shared hooks, domain logic, auth)
│   └── @shogo/ui-kit (theme, routing utilities)
├── @shogo/agent-runtime (agent gateway, heartbeat, channels, skills, Composio)
├── @shogo/project-runtime (isolated project pods)
└── @shogo-ai/sdk (Vite + Hono SDK)
```

## Key Source Locations

### apps/mobile/ (Universal Expo App — Web, iOS, Android)
- `app/` — Expo Router file-based routes
- `app/(app)/` — Authenticated app routes (home, projects, settings, etc.)
- `app/(auth)/` — Auth routes (sign-in, sign-up)
- `app/(admin)/` — Admin routes (dashboard, users, workspaces, analytics)
- `components/chat/` — Chat panel and message rendering
- `components/dynamic-app/` — Canvas renderer (agent dashboards)
- `components/layout/` — Responsive app shell (sidebar, header)
- `components/ui/` — Gluestack v3 universal components
- `contexts/` — Auth and domain providers

### apps/api/src/
- `server.ts` — Hono API server
- `routes/` — API route handlers
- `auth/` — Better Auth integration

## Claude Skills

AI skills are defined in `.claude/skills/`.

## Testing Patterns

Tests use Bun's test runner. Most tests are colocated in `__tests__/` directories.

```bash
# Run all tests
bun run test

# Watch mode
bun test --watch
```

# Shogo AI - Local Development Setup

This guide explains how to set up and run the Shogo AI development environment.

## Architecture

The development environment uses a **hybrid approach**:

- **Docker** for infrastructure (databases, cache, storage)
- **Native bun** for app services (API, MCP, Web) with HMR

This provides the best developer experience with fast hot module replacement.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Local Development Setup                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Docker (Infrastructure)           Native Bun (App Services)    │
│  ┌─────────────────────┐          ┌─────────────────────────┐   │
│  │ PostgreSQL :5432    │◄────────►│ API Server :8002        │   │
│  │ PostgreSQL :5433    │          │ (with HMR)              │   │
│  │ Redis :6379         │          └─────────────────────────┘   │
│  │ MinIO :9000/:9001   │          ┌─────────────────────────┐   │
│  └─────────────────────┘          │ MCP Server :3100        │   │
│                                   │ (with HMR)              │   │
│                                   └─────────────────────────┘   │
│                                   ┌─────────────────────────┐   │
│                                   │ Web Frontend :5173      │   │
│                                   │ (Vite HMR)              │   │
│                                   └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Docker Desktop** - [Install Docker](https://docs.docker.com/get-docker/)
- **Bun** - [Install Bun](https://bun.sh/docs/installation)
- **Node.js 20+** (for Playwright tests)

## Quick Start

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/your-org/shogo-ai.git
cd shogo-ai
bun install
```

### 2. Configure Environment

Copy the template and add your API keys:

```bash
cp .env.local.template .env.local
```

Edit `.env.local` and add your `ANTHROPIC_API_KEY`:

```bash
# Required for AI chat functionality
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start Development Environment

**Option A: Automated startup (macOS)**

```bash
./scripts/docker-dev-start.sh
```

This will:
1. Start Docker infrastructure (Postgres, Redis, MinIO)
2. Run database migrations
3. Open terminal tabs for MCP, API, and Web services

**Option B: Manual startup**

```bash
# Terminal 1: Start infrastructure
bun run docker:infra

# Terminal 2: Start MCP server
bun run mcp:http

# Terminal 3: Start API server
bun run api:dev

# Terminal 4: Start Web frontend
bun run web:dev
```

**Option C: Single terminal with concurrently**

```bash
# Start infrastructure first
bun run docker:infra

# Wait for Postgres to be ready, then run all services
bun run dev
```

### 4. Access the Application

- **Web UI**: http://localhost:5173
- **API**: http://localhost:8002
- **MCP**: http://localhost:3100
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)

## Available Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start all app services (MCP, API, Web) with HMR |
| `bun run dev:start` | Full automated setup (Docker + native services) |
| `bun run dev:infra` | Start only Docker infrastructure |
| `bun run docker:infra` | Start Docker infrastructure services |
| `bun run docker:infra:down` | Stop Docker infrastructure |
| `bun run docker:infra:clean` | Stop Docker and remove volumes |
| `bun run api:dev` | Start API with hot reloading |
| `bun run mcp:http` | Start MCP HTTP server |
| `bun run web:dev` | Start Vite dev server with HMR |
| `bun run test:e2e` | Run Playwright e2e tests |
| `bun run test:e2e:ui` | Run e2e tests with Playwright UI |

## Project Preview

Project previews work **without a separate runtime container**. The API server includes a `RuntimeManager` that spawns Vite dev server processes for each project preview.

- Preview ports: 5200-5219
- Workspaces directory: `./workspaces/`

When you create or open a project, the RuntimeManager:
1. Creates the project directory in `./workspaces/`
2. Copies the runtime template (or uses bundled template)
3. Installs dependencies with `bun install`
4. Spawns a Vite dev server on an available port
5. Returns the preview URL to the frontend

## Running E2E Tests

```bash
# Start infrastructure and services first
bun run docker:infra
bun run dev

# In another terminal, run tests
bun run test:e2e

# Or with UI
bun run test:e2e:ui

# Headed mode (see browser)
cd apps/web && bun run test:e2e:headed
```

## Database Management

```bash
# Run migrations
bun run db:migrate

# Push schema changes (dev only)
bun run db:push

# Open Prisma Studio
bun run db:studio

# Reset database
bun run db:reset
```

## Troubleshooting

### Docker Issues

**Services won't start:**
```bash
# Reset Docker environment
bun run docker:infra:clean
bun run docker:infra
```

**Port conflicts:**
```bash
# Check what's using a port
lsof -i :5432
lsof -i :8002
lsof -i :5173
```

### Database Issues

**Migration errors:**
```bash
# Reset and re-run migrations
bunx prisma migrate reset
```

**Connection refused:**
- Ensure Docker is running: `docker ps`
- Check if Postgres is healthy: `docker compose logs postgres`

### HMR Not Working

1. Check that you're running native bun (not Docker) for app services
2. Verify the Vite dev server is running on port 5173
3. Check browser console for WebSocket errors

### API Proxy Issues

The Vite dev server proxies `/api` requests to the API server. If you see 404 errors:

1. Ensure API server is running on port 8002
2. Check `apps/web/vite.config.ts` proxy configuration
3. Verify CORS settings in `.env.local`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | - | **Required** for AI chat |
| `DATABASE_URL` | `postgres://shogo:shogo_dev@localhost:5432/shogo` | Platform database |
| `PROJECTS_DATABASE_URL` | `postgres://project:project_dev@localhost:5433/projects` | Projects database |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `VITE_PORT` | `5173` | Web frontend port |
| `API_PORT` | `8002` | API server port |
| `MCP_PORT` | `3100` | MCP server port |
| `WORKSPACES_DIR` | `./workspaces` | Project workspaces directory |

### GitHub App Integration (Optional)

To enable GitHub sync for project checkpoints:

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID (from app settings) |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM format, newlines as `\n`) |
| `GITHUB_APP_CLIENT_ID` | GitHub App OAuth client ID |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth client secret |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook secret for signature verification |
| `GITHUB_APP_SLUG` | App slug for installation URL (default: `shogo-ai`) |

See [GitHub App Setup](#github-app-setup) for instructions on creating a GitHub App.

## Stopping Everything

```bash
# Stop Docker infrastructure
bun run docker:infra:down

# Or clean stop (removes volumes)
bun run docker:infra:clean

# Kill app services (Ctrl+C in their terminals)
```

## Team Workflow

1. **Daily development**: Run `./scripts/docker-dev-start.sh` or `bun run dev:start`
2. **Before commits**: Run `bun run test:e2e` to verify
3. **After pulling**: Run `bun install` and `bun run db:migrate`
4. **Database schema changes**: Create migration with `bun run db:migrate`

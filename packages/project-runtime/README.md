# @shogo/project-runtime

Isolated project runtime that runs Claude Code agent + MCP + Vite in a per-project Kubernetes pod.

## Overview

This package provides a complete runtime environment for a single project, including:

- **Agent Server** (port 8080): Receives chat requests from the API and streams responses
- **Claude Code Agent**: Executes code generation and file operations
- **MCP (Wavesmith)**: Provides schema and data management tools
- **Vite Dev Server** (port 5173): Serves the project preview

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Project Pod                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  entrypoint.sh                                                  │
│  ├── 1. Sync files from S3 (if configured)                      │
│  ├── 2. Initialize project (if empty)                           │
│  ├── 3. Install dependencies                                    │
│  ├── 4. Start Vite server (background, port 5173)              │
│  └── 5. Start agent server (foreground, port 8080)             │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐ │
│  │   Agent Server       │  │   Vite Dev Server                │ │
│  │   (Hono)             │  │   (React preview)                │ │
│  │                      │  │                                  │ │
│  │   POST /agent/chat   │  │   http://localhost:5173          │ │
│  │   GET /health        │  │                                  │ │
│  │   GET /ready         │  │                                  │ │
│  └──────────┬───────────┘  └──────────────────────────────────┘ │
│             │                                                    │
│             ▼                                                    │
│  ┌──────────────────────┐                                       │
│  │   Claude Code        │                                       │
│  │   + MCP subprocess   │                                       │
│  │   (Wavesmith)        │                                       │
│  └──────────────────────┘                                       │
│                                                                  │
│  Storage:                                                        │
│  ├── /app/project    (project files - PVC or S3 sync)          │
│  ├── /app/.schemas   (project schemas)                          │
│  └── /app/.claude    (Claude Code session data)                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROJECT_ID` | Yes | - | Unique identifier for the project |
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key for Claude Code agent |
| `PROJECT_DIR` | No | `/app/project` | Path to project files |
| `SCHEMAS_PATH` | No | `/app/.schemas` | Path to schema storage |
| `PORT` | No | `8080` | Agent server port |
| `S3_WORKSPACES_BUCKET` | No | - | S3 bucket for file sync |
| `S3_ENDPOINT` | No | - | Custom S3 endpoint (MinIO) |
| `AI_PROXY_URL` | No | - | Shogo AI proxy URL for user apps (OpenAI-compatible) |
| `AI_PROXY_TOKEN` | No | - | Project-scoped token for the AI proxy |

## API Endpoints

### `GET /health`

Health check for Kubernetes probes.

```json
{
  "status": "ok",
  "projectId": "abc123",
  "projectDir": "/app/project",
  "uptime": 123.45
}
```

### `GET /ready`

Readiness check (verifies project directory exists).

```json
{
  "status": "ready",
  "projectId": "abc123",
  "projectDir": "/app/project"
}
```

### `POST /agent/chat`

Send a chat message to the Claude Code agent.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "Create a hello world component" }
  ],
  "system": "Optional system prompt"
}
```

**Response:** Server-Sent Events (SSE) stream with AI SDK data format.

## Local Development

```bash
# Build the Docker image
docker build -t project-runtime -f packages/project-runtime/Dockerfile .

# Run locally
docker run -it --rm \
  -p 8080:8080 \
  -p 5173:5173 \
  -e PROJECT_ID=test-project \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  project-runtime

# Test health endpoint
curl http://localhost:8080/health

# Test chat endpoint
curl -X POST http://localhost:8080/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## E2E Tests

```bash
# Run Phase 1 E2E tests
./scripts/test-phase1.sh
```

## Kubernetes Deployment

See `k8s/knative/project-service-template.yaml` for the Knative Service template.

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: project-{PROJECT_ID}
spec:
  template:
    spec:
      containers:
        - image: ghcr.io/shogo-ai/project-runtime:latest
          env:
            - name: PROJECT_ID
              value: "{PROJECT_ID}"
```

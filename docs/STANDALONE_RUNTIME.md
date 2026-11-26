# Standalone agent runtime

Run one Shogo agent runtime per session on **your own** infrastructure, with no
Shogo API behind it. This is the contract a partner embeds against: one image,
one mode flag, one model, and a documented HTTP surface.

If you are deploying the whole Shogo product (API, web app, database) rather
than a single runtime, read [SELF_HOSTING.md](./SELF_HOSTING.md) instead.

- [Image](#image)
- [Quick start](#quick-start)
- [Environment contract](#environment-contract)
- [Auth](#auth)
- [Models](#models)
- [Files API](#files-api)
- [Chat stream](#chat-stream)
- [Lifecycle](#lifecycle)
- [Filesystem](#filesystem)
- [Previews](#previews)
- [Starter template](#starter-template)
- [Versions](#versions)
- [What is off in standalone mode](#what-is-off-in-standalone-mode)

## Image

The runtime is published as a multi-arch image on every release tag:

```
ghcr.io/shogo-labs/shogo-runtime:vX.Y.Z
ghcr.io/shogo-labs/shogo-runtime:sha-<commit>
```

Both tags are manifest lists covering `linux/amd64` and `linux/arm64`, so
`docker pull` resolves to the host's architecture. The package is public: no
credentials are needed to pull it. The per-arch digests are appended to the
GitHub Release notes for the tag, so you can pin by digest:

```yaml
image: ghcr.io/shogo-labs/shogo-runtime@sha256:<digest>
```

**Size.** About 6.7 GB compressed, ~14 GB on disk. The image carries Chromium,
ffmpeg, ripgrep, the AWS CLI, the GitHub CLI, pyright and the MCP packages, plus
a pre-installed `node_modules` for the runtime and the starter template. See
[runtime-image-audit.md](./runtime-image-audit.md) for the breakdown and the
slimming options; there is no smaller variant today.

**Bun floor.** The image is built on Bun 1.4.4. Do not rebuild it on an older
Bun: 1.4.4 carries the fix for the CVE that affects earlier 1.4.x releases.

### Building it yourself

The image is a three-stage chain. Each stage is a separate Dockerfile, and the
later stages take the earlier ones as build args:

```bash
# 1. System packages: python:3.12-slim + chromium, ffmpeg, aws cli, gh, pyright, MCP
docker build -f packages/agent-runtime/Dockerfile.base -t shogo-runtime-base .

# 2. Workspace deps: oven/bun:1.4.4-debian, bun install + build:packages
docker build -f docker/workspace-deps/Dockerfile \
  --build-arg BASE_IMAGE=shogo-runtime-base \
  -t shogo-workspace-deps .

# 3. Runtime: layers source onto the base, relinks node_modules, USER appuser
docker build -f packages/agent-runtime/Dockerfile \
  --build-arg BASE_IMAGE=shogo-runtime-base \
  --build-arg WORKSPACE_DEPS=shogo-workspace-deps \
  --build-arg SHOGO_RUNTIME_REVISION=$(git rev-parse HEAD) \
  -t shogo-runtime .
```

Every base image is public (`python:3.12-slim`, `oven/bun:1.4.4-debian`).

`packages/agent-runtime/Dockerfile.swe-overlay` is **not** for standalone use.
It is an internal overlay for our own SWE-bench-style evals; it is not published
and its assumptions (a Shogo API, a warm pool) do not hold here.

## Quick start

```bash
docker run --rm -p 8080:8080 \
  -e SHOGO_STANDALONE=1 \
  -e RUNTIME_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e AGENT_MODEL=local:qwen3-coder \
  -e OPENAI_BASE_URL=http://host.docker.internal:11434/v1 \
  -e OPENAI_API_KEY=local \
  -v "$PWD/workspace:/app/workspace" \
  ghcr.io/shogo-labs/shogo-runtime:vX.Y.Z
```

Then:

```bash
curl -s localhost:8080/health
# {"status":"ok","projectId":"standalone",...}

curl -s -H "Authorization: Bearer $RUNTIME_AUTH_SECRET" \
  localhost:8080/agent/workspace/files/hello.txt \
  -X PUT -H 'content-type: application/json' \
  -d '{"content":"hello\n"}'
```

### Smoke test

`scripts/standalone-runtime-smoke.sh` boots the image the way a hardened
deployment does — `--read-only` root filesystem, every writable path from
[Filesystem](#filesystem) mounted, `SHOGO_STANDALONE=1`, no Shogo API — and
then checks that it is actually usable:

```bash
scripts/standalone-runtime-smoke.sh ghcr.io/shogo-labs/shogo-runtime:vX.Y.Z
```

It fails if `/health` never answers, if `/agent/*` accepts a request without a
token, if the files API does not round-trip a multi-byte UTF-8 file with a
byte-accurate `bytes` count, if the file does not land on the mounted volume,
or if the container logs an `EROFS` write. Run it against a release tag before
you roll that tag out.

## Environment contract

`SHOGO_STANDALONE=1` is the switch. With it set:

- the runtime **fails at boot** if a required variable is missing, with one
  message naming every missing variable;
- `WARM_POOL_MODE=true` is refused (a standalone runtime is statically bound to
  its own workspace and is never a warm-pool pod);
- `PROJECT_ID` defaults to `standalone`;
- no outbound call to a Shogo service is made, ever.

The table below is generated from the source by
`scripts/gen-runtime-env-doc.ts`. A test fails when the code reads a variable
the table does not list, or the table lists one the code no longer reads.

- **required** — boot fails without it. The provider variables are required
  *for the provider named in `AGENT_MODEL`*: a `local:` pin needs
  `OPENAI_BASE_URL` (or `LOCAL_LLM_BASE_URL`), an `openai:` pin needs both the
  base URL and the key, and so on.
- **ignored** — read by the runtime, but only meaningful with a Shogo platform
  behind it. Set them and nothing happens.
- **off unless set** — a feature that is disabled until you name it.
- **optional** — a tuning knob with a working default.

<!-- BEGIN GENERATED ENV TABLE -->

The runtime reads 183 environment variables. This table is generated from the source by
`scripts/gen-runtime-env-doc.ts`; a test fails when the code and the table disagree.

| Variable | Standalone | Default | Purpose |
| --- | --- | --- | --- |
| `AGENT_ADVANCED_MODEL` | optional | — | — |
| `AGENT_AUTOCOMPACT_TOKENS` | optional | — | — |
| `AGENT_AUTO_TIER_MAP` | ignored | — | — |
| `AGENT_BASIC_MODEL` | optional | — | — |
| `AGENT_BASIC_THINKING_LEVEL` | off unless set | — | Reasoning effort for `basic` agent mode. |
| `AGENT_DIR` | optional | `/app/workspace` | — |
| `AGENT_EMBEDDING_MODEL` | off unless set | — | Embedding model your endpoint serves. Unset means the index and memory use FTS only. |
| `AGENT_IDLE_COMPACT_MINUTES` | optional | — | — |
| `AGENT_INLOOP_CONTEXT_BUDGET_TOKENS` | optional | — | — |
| `AGENT_MAX_AUTO_CONTINUATIONS` | optional | `3` | — |
| `AGENT_MAX_ITERATIONS` | optional | `200` | — |
| `AGENT_MAX_PLAN_CONTINUATIONS` | optional | — | — |
| `AGENT_MODEL_REGISTRY` | ignored | — | — |
| `AGENT_RESUME_MAX_AGE_MINUTES` | optional | — | — |
| `AGENT_SUMMARIZER_MODEL` | ignored | — | — |
| `AGENT_THINKING_LEVEL` | off unless set | — | Default reasoning effort for turns. |
| `AI_PROXY_TOKEN` | ignored | — | — |
| `AI_PROXY_URL` | ignored | — | — |
| `ALLOWED_ORIGINS` | optional | — | — |
| `API_SERVER_PORT` | optional | — | — |
| `API_URL` | ignored | `http://localhost:8002` | — |
| `ASSIGNED_PROJECT` | ignored | — | — |
| `AWS_ACCESS_KEY_ID` | ignored | — | — |
| `AWS_SECRET_ACCESS_KEY` | ignored | `` | — |
| `BETTER_AUTH_SECRET` | optional | — | — |
| `BETTER_AUTH_URL` | optional | — | — |
| `BROWSER_ACTION_TIMEOUT_MS` | optional | — | — |
| `BROWSER_CDP_ENDPOINT` | optional | — | — |
| `BROWSER_CHANNEL` | optional | `chrome` | — |
| `BROWSER_PAGE_PROBE_TIMEOUT_MS` | optional | — | — |
| `COMPACTION_SUMMARY_INPUT_CHARS` | optional | — | — |
| `COMPACTION_TAIL_BUDGET_RATIO` | optional | — | — |
| `COMPOSIO_API_KEY` | ignored | — | — |
| `COMPOSIO_CLOUD_USER_ID` | ignored | — | — |
| `COMPOSIO_CLOUD_WORKSPACE_ID` | ignored | — | — |
| `COMPOSIO_MAX_RESULT_CHARS` | ignored | — | — |
| `COMPOSIO_NOTFOUND_RETRY_DELAY_MS` | ignored | — | — |
| `COMPOSIO_USER_SCOPE` | ignored | — | — |
| `DATABASE_URL` | optional | `` | — |
| `DEBUG_SCREENCAST` | optional | — | — |
| `ELEVENLABS_API_KEY` | optional | — | — |
| `FFMPEG_PATH` | optional | — | Explicit path to `ffmpeg`, for an install that is not on `PATH`. It re-encodes a video read for a model that samples at a fixed rate. |
| `FFPROBE_PATH` | optional | — | Explicit path to `ffprobe`. When neither it nor the MP4 box walk can read a clip, the read reports no frame count rather than guessing. |
| `GITHUB_TOKEN` | optional | — | — |
| `HOME` | optional | — | Home directory for tool config and caches. The image sets `/app`. |
| `HOMEBREW_PREFIX` | optional | — | Homebrew root: `<prefix>/bin` is searched for `ffmpeg`/`ffprobe`. `/opt/homebrew/bin` is searched anyway. |
| `HOST` | optional | — | Bind address. Defaults to Bun's default (all interfaces). |
| `K8S_SA_TOKEN_OVERRIDE` | optional | — | — |
| `KNATIVE_SERVICE_NAME` | ignored | — | — |
| `KUBERNETES_SERVICE_HOST` | ignored | — | — |
| `LINKED_FOLDERS` | optional | — | JSON array of extra roots the agent may touch. |
| `LOCALAPPDATA` | optional | `` | — |
| `LOCAL_LLM_BASE_URL` | required | — | Alternative to `OPENAI_BASE_URL` for a local endpoint. Also forces thinking off. |
| `MAX_AGENT_INSTANCES` | optional | `` | — |
| `MAX_AGENT_TYPES` | optional | `` | — |
| `MAX_CHAT_ATTACHMENT_BYTES` | optional | — | — |
| `MAX_TOTAL_SPAWNS` | optional | `` | — |
| `MCP_PREINSTALL_DIR` | optional | `/app/mcp-packages` | — |
| `MOUNT_WORKSPACE` | optional | — | — |
| `NAME` | optional | — | — |
| `NODE_ENV` | optional | — | `production` requires `RUNTIME_AUTH_SECRET`; anything else lets an unauthenticated runtime boot. |
| `OPENAI_API_KEY` | required | — | Key for the `openai` provider. A local endpoint usually accepts any non-empty value. |
| `OPENAI_BASE_URL` | required | — | Base URL of an OpenAI-compatible endpoint (used by the `local` and `openai` providers). |
| `OTEL_SERVICE_NAME` | ignored | — | — |
| `P` | optional | — | — |
| `PATH` | optional | `` | — |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | optional | `` | — |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | optional | — | — |
| `POOL_BOOTSTRAP_SECRET` | ignored | `` | — |
| `PORT` | optional | `8080` | HTTP port. Defaults to `8080`. |
| `POSTGRES_BACKUP_INTERVAL` | optional | `60000` | — |
| `POSTGRES_DB` | optional | `project` | — |
| `POSTGRES_PASSWORD` | optional | `shogo` | — |
| `POSTGRES_S3_BACKUP_ENABLED` | optional | — | — |
| `POSTGRES_USER` | optional | `shogo` | — |
| `PREVIEW_TOKEN_SECRET` | optional | — | — |
| `PROJECT_DIR` | optional | `/app/workspace` | — |
| `PROJECT_ID` | optional | `` | Identity reported by `/health`. Defaults to `standalone` in standalone mode. |
| `PUBLIC_PREVIEW_URL` | optional | `` | — |
| `PUBLISHED_DATA_PATHS` | ignored | — | — |
| `PUBLISHED_DATA_SYNC_INTERVAL` | ignored | `30000` | — |
| `PUBLISHED_DATA_WATCH` | ignored | — | — |
| `PUBLISHED_SUBDOMAIN` | ignored | `` | — |
| `PUBLISH_DATA_BUCKET` | optional | — | — |
| `READONLY_ROOTS` | optional | — | JSON array of roots mounted read-only. |
| `RUNTIME_AUTH_SECRET` | required | — | The only accepted token on `/agent/*`. Sent as `Authorization: Bearer …` or `x-runtime-token`. |
| `RUNTIME_ENABLED` | optional | — | — |
| `RUNTIME_IMAGE` | optional | — | — |
| `RUNTIME_PORT` | optional | `8080` | — |
| `RUNTIME_TEMPLATE_DIR` | optional | — | Starter template the runtime seeds a new project from. |
| `S3_BUCKET` | ignored | — | — |
| `S3_DOWNLOAD_TIMEOUT_MS` | ignored | `` | — |
| `S3_ENDPOINT` | ignored | — | — |
| `S3_FORCE_PATH_STYLE` | ignored | — | — |
| `S3_PUBLISHED_DATA_BUCKET` | ignored | — | — |
| `S3_REGION` | ignored | `us-east-1` | — |
| `S3_STORAGE_QUOTA_BYTES` | ignored | `0` | — |
| `S3_SYNC_INTERVAL` | ignored | `30000` | — |
| `S3_WATCH_ENABLED` | ignored | — | — |
| `S3_WORKSPACES_BUCKET` | ignored | — | — |
| `SANDBOX_EXEC_ENABLED` | optional | — | — |
| `SANDBOX_IMAGE` | optional | `ubuntu:22.04` | — |
| `SCHEMAS_PATH` | optional | `/app/.schemas` | Where the runtime writes its JSON schemas. The image sets `/app/.schemas`. |
| `SECURITY_POLICY` | optional | — | — |
| `SERPER_API_KEY` | optional | — | — |
| `SHELL` | optional | — | — |
| `SHOGO_API_KEY` | optional | — | — |
| `SHOGO_API_URL` | ignored | — | — |
| `SHOGO_APP_TOKEN` | optional | — | — |
| `SHOGO_CHECKPOINT_REPAIR` | optional | — | — |
| `SHOGO_CLOUD_SYNC` | optional | — | — |
| `SHOGO_CLOUD_URL` | optional | `https://studio.shogo.ai` | — |
| `SHOGO_CREDENTIAL_APPROVAL_POLL_MS` | optional | — | — |
| `SHOGO_DEVICE_NAME` | optional | — | — |
| `SHOGO_DURABILITY_HOST_MEDIATED` | optional | — | — |
| `SHOGO_EVAL_MODE` | optional | — | — |
| `SHOGO_EXEC_MEMORY_MB` | optional | `` | — |
| `SHOGO_EXEC_MEMORY_SAMPLE_MS` | optional | `15000` | — |
| `SHOGO_EXEC_MEMORY_STRIKES` | optional | `2` | — |
| `SHOGO_EXEC_PIDS_FILE` | optional | — | — |
| `SHOGO_EXPOSED_PORTS` | optional | — | — |
| `SHOGO_HOST_LIMITS_FILE` | optional | — | — |
| `SHOGO_HOST_WORKSPACES_ROOT` | ignored | `/host-workspaces` | — |
| `SHOGO_INDEX_PREWARM` | optional | `` | — |
| `SHOGO_INDEX_START_DELAY_MS` | optional | `3000` | — |
| `SHOGO_INTERACTIVE_CWD` | optional | — | — |
| `SHOGO_LFS_CONCURRENT_TRANSFERS` | optional | `` | In-flight `git lfs push` transfers. Defaults to `2` (capped at `16`) so a small VM does not buffer eight objects at once. |
| `SHOGO_LOCAL_MODE` | optional | — | — |
| `SHOGO_LSP_DEPS_WAIT_MS` | optional | `60000` | — |
| `SHOGO_LSP_START_DELAY_MS` | optional | `2000` | — |
| `SHOGO_MCP_PIN_HTTP_TO_CLOUD` | optional | — | — |
| `SHOGO_MOCK_CAPTURE_DIR` | optional | `` | — |
| `SHOGO_MODEL` | optional | — | — |
| `SHOGO_NO_TUI` | optional | — | — |
| `SHOGO_OPEN_ID` | optional | — | — |
| `SHOGO_PERF_LOG` | optional | — | — |
| `SHOGO_PERMISSION_SCOPE` | optional | — | — |
| `SHOGO_POOL_SENTINEL` | ignored | — | — |
| `SHOGO_POOL_SKIP_PRESEED` | ignored | — | — |
| `SHOGO_POOL_STATE_DIR` | ignored | — | — |
| `SHOGO_PREBUILT_IMAGE` | optional | — | — |
| `SHOGO_PREFIX_LOG` | optional | — | — |
| `SHOGO_PUBLIC_API_URL` | ignored | — | — |
| `SHOGO_PUBLISHED_MODE` | optional | — | — |
| `SHOGO_READ_LINTS_WAIT_MS` | optional | — | — |
| `SHOGO_RG_PATH` | optional | — | — |
| `SHOGO_ROOT_SYNC_INTERVAL_MS` | optional | — | — |
| `SHOGO_ROOT_SYNC_SCAN_MS` | optional | — | — |
| `SHOGO_RUNTIME_CLASS` | optional | — | — |
| `SHOGO_RUNTIME_MODE` | optional | — | — |
| `SHOGO_SEARCH_ENABLED` | optional | `` | — |
| `SHOGO_STANDALONE` | off unless set | — | Set to `1` to run with no Shogo API. Turns off every platform-bound caller. |
| `SHOGO_STREAM_TRACE` | optional | — | — |
| `SHOGO_TEAMS_TEST_AUTHORITY` | optional | — | — |
| `SKILL_SERVER_PORT` | optional | — | — |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | optional | `16000` | — |
| `STARTUP_TIME` | optional | — | — |
| `STOP_REAP_GRACE_MS` | optional | — | — |
| `STREAM_ORPHAN_TTL_MS` | optional | — | — |
| `TECH_STACK_ID` | optional | `` | — |
| `TERMINAL_EXEC_TOKEN` | optional | `` | — |
| `TERMINAL_EXEC_URL` | optional | — | — |
| `TOOLS_PROXY_URL` | ignored | — | — |
| `TREE_SITTER_WASM_DIR` | optional | — | — |
| `TRUST_LEVEL` | optional | — | — |
| `USER_ID` | optional | `default` | — |
| `VM_WORKSPACE_MOUNTED` | ignored | — | — |
| `WARM_POOL_MODE` | ignored | — | — |
| `WEBHOOK_TOKEN` | optional | — | — |
| `WEB_CACHE_REDIS_URL` | optional | — | — |
| `WORKING_MODE` | optional | — | `managed` (Shogo owns the workspace) or `external` (a linked folder). |
| `WORKSPACE_ANCHOR_PROJECT_ID` | optional | `` | — |
| `WORKSPACE_API_PORT_BASE` | optional | `3101` | — |
| `WORKSPACE_DIR` | optional | — | The workspace root the agent reads and writes. Defaults to `/app/workspace`. |
| `WORKSPACE_ID` | ignored | `default` | — |
| `WORKSPACE_KIND` | optional | — | — |
| `WORKSPACE_NEW_PROJECT_IDS` | optional | — | — |
| `WORKSPACE_PREVIEW_URLS` | optional | `{}` | — |
| `WORKSPACE_PROJECT_IDS` | optional | `none` | — |
| `WORKSPACE_RUNTIME` | optional | — | — |
| `WORKSPACE_RUNTIME_AUTH_SECRET` | ignored | — | — |
| `WORKSPACE_RUNTIME_KEY` | optional | — | — |
| `WORKSPACE_TECH_STACKS` | optional | `{}` | — |

<!-- END GENERATED ENV TABLE -->

## Auth

`/agent/*` requires a token. In standalone mode `RUNTIME_AUTH_SECRET` is the
**only** accepted token, compared byte for byte — there is no API to validate
anything against, and no preview-token callback.

```http
Authorization: Bearer $RUNTIME_AUTH_SECRET
```

or

```http
x-runtime-token: $RUNTIME_AUTH_SECRET
```

A request without it gets `401` with `{"code":"auth_mismatch","apiVerdict":"standalone"}`.

`/` and `/api/*` are **not** authenticated. `/` serves the built app and
`/api/*` proxies to the project's own API sidecar. Your ingress owns access
control for those two — put the session behind your own auth (a signed cookie, a
JWT at the edge, mTLS) before exposing it.

`/health` and `/ready` are unauthenticated by design, for probes.

## Models

`AGENT_MODEL=<provider>:<model>` pins **every** model pick in the process:

- the Auto router (economy / standard / premium all resolve to the pin);
- the context summarizer, including its `claude-haiku-4-5` fallback;
- heartbeat ticks, including their `hoshi-2-0` fallback;
- subagent tiers, a built-in subagent's own default, and a caller's `--model`;
- the project's `config.json` model.

Only the first colon separates provider from model, so an id that contains a
colon survives: `AGENT_MODEL=local:qwen2.5:3b` is provider `local`, model
`qwen2.5:3b`. A value with no colon is taken as a bare model id on the `local`
(OpenAI-compatible) provider.

### Reference config: an OpenAI-compatible endpoint

```yaml
env:
  - name: SHOGO_STANDALONE
    value: "1"
  - name: RUNTIME_AUTH_SECRET
    valueFrom: { secretKeyRef: { name: runtime-auth, key: secret } }
  - name: AGENT_MODEL
    value: "local:qwen3-coder"
  - name: OPENAI_BASE_URL
    value: "http://vllm.default.svc.cluster.local:8000/v1"
  - name: OPENAI_API_KEY
    value: "not-needed"
```

`LOCAL_LLM_BASE_URL` works as an alternative to `OPENAI_BASE_URL` and, as a
side effect, forces thinking off — Ollama-style servers reject the provider's
reasoning parameters.

### `AGENT_MODEL_REGISTRY`

The pin decides *which* model; the registry still decides its context window
and max output tokens. It is a JSON array:

```json
[
  {
    "id": "qwen3-coder",
    "provider": "local",
    "contextWindow": 131072,
    "maxTokens": 16384
  }
]
```

Without an entry the runtime falls back to the catalog defaults for that id, or
to a conservative window for an id it has never seen.

### Precedence

`AGENT_MODEL` > `AGENT_AUTO_TIER_MAP` / `AGENT_SUMMARIZER_MODEL` /
`AGENT_MODEL_REGISTRY` > the project's `config.json` model > the built-in
defaults. Unset `AGENT_MODEL` and every path behaves exactly as it does in the
cloud.

## Files API

`/agent/workspace/files/*` is the supported way to read and write project files.
All paths are relative to the workspace root.

**Read** — `GET /agent/workspace/files/<path>`

Text:

```json
{ "path": "src/app.ts", "content": "…", "encoding": "utf-8", "bytes": 1234 }
```

Binary (any path whose extension is in the binary list, or whose bytes are not
valid UTF-8):

```json
{ "path": "assets/logo.png", "contentBase64": "iVBORw0…", "encoding": "base64", "bytes": 5678 }
```

`bytes` is always the **byte** count of the file, not a character count. Branch
on `encoding`; never assume `content` is present.

A read returns a weak `ETag` (`W/"<mtime>-<size>"`). Send it back as
`If-None-Match` and an unchanged file answers `304` with no body.

**Write** — `PUT /agent/workspace/files/<path>`

```json
{ "content": "utf-8 text" }
```

or, for binary:

```json
{ "contentBase64": "iVBORw0…" }
```

A `content` write to a binary path is refused with `400` — send `contentBase64`
instead, so a read-as-text / write-as-text round-trip cannot corrupt the file.
The response is `{ ok, path, bytes, encoding }`.

**Delete** — `DELETE /agent/workspace/files/<path>`. A directory is refused
unless you add `?recursive=true`.

**Scope.** By default paths are resolved against the merged workspace root.
`?scope=project` resolves them against the project's own root instead — the path
space your IDE shows. Use the default unless you are addressing a file inside
the project directory specifically. In standalone mode the root is
`$WORKSPACE_DIR` and `?scope=project` resolves to that same folder, so the two
scopes are equivalent.

`/agent/files/:filename` is a different, narrower route: it serves the runtime's
own config files (`AGENTS.md`, `MEMORY.md`, …), not project files.

## Chat stream

`POST /agent/chat` starts a turn and streams it back as
`text/x-ai-sdk-ui-stream` (the AI SDK UI message protocol). The body is
`{ messages: [{ role, parts }], chatSessionId? }`.

Every frame is a `data:` line carrying a JSON object with a `type`. Two families:

**AI SDK UI message parts** — stable, part of the AI SDK contract:

| Type | Meaning |
| --- | --- |
| `text-start` / `text-delta` / `text-end` | Assistant text, streamed. |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | Reasoning tokens, when the model emits them. |
| `tool-input-start` / `tool-input-delta` / `tool-input-available` | A tool call being built. |
| `tool-output-available` / `tool-output-error` | A tool call's result. |
| `start` / `start-step` / `finish-step` / `finish` | Turn and step boundaries. |
| `error` | A turn-level error. |

**`data-*` parts** — the runtime's own annotations:

| Type | Stability | Meaning |
| --- | --- | --- |
| `data-turn-start` | stable | A turn began. Carries the turn id. |
| `data-turn-seq` | stable | Monotonic sequence number for resume. |
| `data-turn-complete` | stable | The turn is terminal. Carries the final status. |
| `data-usage` | stable | Token usage for the turn. |
| `data-routing-decision` | stable | Which model the Auto router picked, and why. |
| `data-context-usage` | stable | How full the context window is. |
| `data-tool-progress` | stable | Progress from a long-running tool. |
| `data-tool-error` | stable | A tool failed; the turn continues. |
| `data-inference-retry` | stable | The model call is being retried. |
| `data-usage-limit` | stable | The turn stopped on a usage limit. |
| `data-context-summarized` | internal | The context was compacted. |
| `data-routing-fallback` | internal | The router fell back to another model. |
| `data-prompt-breakdown` | internal | Prompt section sizes, for debugging. |
| `data-connectivity-wait` | internal | The runtime waited for a device. |
| `data-permission-request` | internal | A tool asked for approval. |
| `data-plan` / `data-plan-update` / `data-plan-summary*` | internal | Plan-mode frames. |
| `data-task-update` / `data-task-wait` / `data-process-update` | internal | Background task frames. |
| `data-agent-types` | internal | The subagent types this runtime offers. |
| `data-integration-*` | internal | Managed-integration auth frames (never emitted standalone). |
| `data-team-*` / `data-teammate-*` | internal | Team frames (never emitted standalone). |

Treat `internal` as "may change without notice". Build on the AI SDK parts and
the `stable` rows.

### Resume

`GET /agent/chat/:chatSessionId/stream` reattaches to a turn.

| Query | Effect |
| --- | --- |
| `fromSeq=<n>` | Replay only frames with `seq > n`, so a client that already rendered part of the turn does not duplicate it. |
| `snapshot=1` | With `fromSeq=0`, replay the turn so far as one `data-message-snapshot` chunk, then live frames. |
| `compact=0` | Replay buffered frames raw instead of compacted. |

Response headers: `X-Turn-Id`, `X-Last-Seq`, `X-Turn-Status`
(`active` / `completed` / `failed` / `aborted`).

`200` means a buffer exists and is being replayed. `204` means there is nothing
to resume (unknown session, or the turn aged out of the grace window) — stop,
do not retry.

`GET /agent/chat/:chatSessionId/turn` is the polling equivalent: the turn's
current state and, once terminal, its final text.

## Lifecycle

`SIGTERM` starts a graceful drain:

1. **In-flight streams** — wait for them to finish, up to 30 s, polled every
   500 ms. A stream still open at the deadline is abandoned with a warning.
2. **Session saves** — flush pending writes, up to 2 s.
3. **Published-data flush** — up to 10 s (only in published mode).
4. **Git flush** — up to 5 s, plus any S3 flush (only when a sync is
   configured; standalone has none).

With no syncs configured the worst case is about **32 s**. Set
`terminationGracePeriodSeconds: 60` so the kubelet does not `SIGKILL` the pod
mid-drain.

`SIGINT` follows the same path.

## Filesystem

The runtime writes to these paths. With `readOnlyRootFilesystem: true` every one
of them needs a writable mount.

| Path | What it holds | Mount |
| --- | --- | --- |
| `/app/workspace` | The project: source, `dist/`, `.shogo/` (state, logs, plans, skills) | PVC (persistent) |
| `/app/.schemas` | JSON schemas written at boot | `emptyDir` |
| `/app/.claude` | Tool config the runtime generates | `emptyDir` |
| `/app/.npm` | `NPM_CONFIG_CACHE` | `emptyDir` |
| `/app/.bun` | Bun's install cache | `emptyDir` |
| `/app/.config`, `/app/.cache`, `/app/.local` | `HOME=/app` dotdirs for tools | `emptyDir` |
| `/tmp` | Scratch, spool files, the pool sentinel | `emptyDir` |

```yaml
securityContext:
  runAsUser: 1001
  runAsGroup: 1001
  readOnlyRootFilesystem: true
volumes:
  - name: workspace
    persistentVolumeClaim: { claimName: agent-workspace }
  - name: schemas
    emptyDir: {}
  - name: claude
    emptyDir: {}
  - name: npm-cache
    emptyDir: {}
  - name: bun-cache
    emptyDir: {}
  - name: home-config
    emptyDir: {}
  - name: tmp
    emptyDir: {}
volumeMounts:
  - { name: workspace, mountPath: /app/workspace }
  - { name: schemas, mountPath: /app/.schemas }
  - { name: claude, mountPath: /app/.claude }
  - { name: npm-cache, mountPath: /app/.npm }
  - { name: bun-cache, mountPath: /app/.bun }
  - { name: home-config, mountPath: /app/.config }
  - { name: home-config, mountPath: /app/.cache, subPath: cache }
  - { name: home-config, mountPath: /app/.local, subPath: local }
  - { name: tmp, mountPath: /tmp }
```

The image runs as uid/gid `1001` (`appuser`). Mount the workspace with that
ownership, or the agent cannot write to it.

## Previews

The runtime serves the built app at `/` and proxies `/api/*` to the project's
own API sidecar. Two ways to route it:

**Host per session (recommended).** Give each runtime its own hostname
(`abc123.preview.example.com`) and route everything to port 8080. Nothing else
is needed.

**Path prefix.** If your ingress routes by path (`example.com/s/abc123/`), set
`PREVIEW_BASE_PATH=/s/abc123`. The runtime then:

- injects a small inline script into `index.html`, before any app script, that
  rewrites same-origin absolute `/api/...` in `fetch`, `XMLHttpRequest` and
  `EventSource` to `/s/abc123/api/...`;
- adds `<base href="/s/abc123/">` when the document has none, so relative asset
  URLs resolve under the prefix;
- accepts requests that still carry the prefix, so it works whether or not your
  ingress strips it.

No template change is needed, and agent-written `fetch('/api/…')` keeps working.
Unset means no change at all.

## Starter template

A new project is seeded from a starter template. The runtime picks the tech
stack from a `.tech-stack` marker in the workspace, falling back to the
`tech-stacks/` registry, and copies the template from `RUNTIME_TEMPLATE_DIR`
(the image sets it to the bundled `templates/runtime-template`).

The template must contain:

- a `package.json` with `dev`, `build` and `start` scripts;
- a `vite.config.ts` (or the equivalent for the stack) with `base: './'`, so
  assets work under a path prefix;
- an `index.html` at the root.

Partners own their template: point `RUNTIME_TEMPLATE_DIR` at your own directory
and the runtime seeds from it instead.

## Versions

Pin by digest, not by tag:

```yaml
image: ghcr.io/shogo-labs/shogo-runtime@sha256:<digest>
```

We support the last two minor release tags. A digest never changes; a tag can be
re-pointed by a rebuild, so a digest is the only reproducible pin.

## What is off in standalone mode

Everything that needs the Shogo platform is switched off, and says so:

| Area | Behaviour |
| --- | --- |
| Trust | Statically `trusted`. The workspace is yours; there is nothing to gate and no API to ask. |
| Capability sync | Off. Capability toggles come from the image defaults. |
| Subagent model overrides | Off. Subagents use `AGENT_MODEL`. |
| Task notifications, cost metrics, git-sync bootstrap | Off. |
| Runtime-token validation | Byte-compare against `RUNTIME_AUTH_SECRET` only. |
| S3 / published-data / large-file sync | Off (env-gated; leave the `S3_*` variables unset). |
| OpenTelemetry | Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. |
| Managed integrations (Composio) | Off. The tools stay in the list and return "not available in standalone mode". |
| Media / 3D / transcription tools | Off, same way — they need the AI proxy. |
| Embeddings | Off unless `AGENT_EMBEDDING_MODEL` is set. The index and memory fall back to full-text search. |
| Channels, team chat, boards, triggers, publishing, GitHub | Off, same way. |

A tool that needs the platform is **not** silently removed: it stays in the
agent's tool list and returns a clear "not available in standalone mode" result,
so the agent can explain the gap instead of pretending the capability exists.

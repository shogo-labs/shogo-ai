<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# A2A (Agent2Agent) protocol

Status: **implemented**, gated behind `A2A_ENABLED` — inert (routes not mounted)
until that flag is set, so this ships dark by default.

Exposes each project's coding agent over the [A2A protocol](https://a2a-community.github.io/A2A/)
so external callers can discover it (agent card), send it queries
(`message/send`), poll for results (`tasks/get`), and — the main way shogo's
implementation goes beyond the reference — listen to the full turn as it
happens (`message/stream` over SSE).

Implementation: `apps/api/src/lib/a2a/*` and `apps/api/src/routes/a2a.ts`,
mounted from `apps/api/src/server.ts`. Built against `@a2a-js/sdk@1.1.0`.

This is shogo's version of the A2A server `alignment-project-server` already
runs in odin-dev-stack (`services/a2a/*`, `routes/a2a.py`). The core pieces
mirror that implementation 1:1 (bearer key shape, task store, card
structure); the sections below call out where and why shogo's differs.

## Why this looks different from Odin's

In Odin, an agent is a DB row invoked in-process — `OdinAgentExecutor` calls
`ToolUseAgent.ainvoke()` directly. In shogo, the agent is a **per-project pod**
(`AgentGateway` in `packages/agent-runtime/src/gateway.ts`) that `apps/api`
proxies to over HTTP. So `ShogoAgentExecutor` is a *stream consumer*, not an
in-process invoker: it `POST`s to the pod's `/agent/chat` and maps its AI SDK
`UIMessageChunk` SSE stream onto A2A events. That single fact drives most of
the differences from Odin below — the resume-on-EOF logic, the
one-turn-per-context guard, and `capabilities.streaming: true` (Odin's is
`false`; it doesn't stream at all).

```
Client ──Bearer shogo_a2a_...──▶ /a2a/projects/:id/rpc (Hono)
                                        │
                                JsonRpcTransportHandler (@a2a-js/sdk/server)
                                        │
                                DefaultRequestHandler
                                        │
                                ShogoAgentExecutor
                                        │
                               POST {podUrl}/agent/chat  ──▶  AgentGateway (runtime pod)
                                        │
                        tee: mapPodChunkToA2AEvents ──▶ ExecutionEventBus ──▶ SSE
                             trackUsageFromStream    ──▶ billing + ChatMessage/ToolCallLog
```

## Endpoints

All protocol routes live under `/a2a`, deliberately **outside** `/api/*` —
they self-authenticate with A2A bearer keys rather than the session/runtime
tokens `authMiddleware` expects, and get their own rate limiter
(`RATE_LIMIT_A2A_MAX` / `RATE_LIMIT_A2A_WINDOW_MS`, default 300 req/min) since
the `/api/*` and `/v1/*` limiters don't cover them.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/a2a/projects/:projectId/.well-known/agent-card.json` | `shogo_a2a_*` bearer | Fetch the agent card |
| `POST` | `/a2a/projects/:projectId/rpc` | `shogo_a2a_*` bearer | JSON-RPC 2.0 endpoint — `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/list`, `tasks/resubscribe` |

Key management is normal product surface, so it lives under `/api` and
inherits session auth (`authorizeProject`) instead:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/a2a/keys` | Session | Mint a new key. Response includes the raw key **once** |
| `GET` | `/api/projects/:projectId/a2a/keys` | Session | List keys (metadata only — never the secret) |
| `DELETE` | `/api/projects/:projectId/a2a/keys/:keyId` | Session | Revoke a key |

Key management stays up regardless of `A2A_ENABLED` — minting a key that
can't be used yet is harmless, and it avoids a chicken-and-egg rollout where
the protocol can't be tested until keys already exist.

## Token format

`shogo_a2a_<keyId>.<secret>` — mirrors Odin's `odin_a2a_<key_id>.<secret>`.

- `keyId`: 12 random bytes, hex-encoded, stored **plaintext** in
  `A2aApiKey.keyId` (unique-indexed). Not secret — it's a lookup key so
  verification is a single `findUnique` instead of a table scan hashing
  every row.
- `secret`: 32 random bytes, hex-encoded. Hashed at rest with the repo's
  existing SHA-256 `hashApiKey()` (`lib/api-keys-mint.ts`) — same primitive as
  `shogo_sk_*` keys, not Odin's bcrypt. A fast hash is fine here: unlike a
  user-chosen password, there's no offline-guessing risk to mitigate with a
  slow KDF given 256 bits of random secret entropy.
- Comparison is `crypto.timingSafeEqual` on the hashed value.
- Every key is scoped to exactly one `projectId`; a key minted for project A
  is rejected for project B.

**Every verification failure is indistinguishable to the caller.** Malformed
token, unknown `keyId`, revoked, expired, and wrong-project all collapse to
the same `401` with `WWW-Authenticate: Bearer` — a probing client can't use
response shape or timing to enumerate projects or valid `keyId`s.

## The agent card requires auth

Unlike most A2A servers, `GET /.well-known/agent-card.json` is **not**
public here — it sits behind the same per-project bearer check as `/rpc`.
This matches Odin's `require_a2a_key` on the card route and prevents project
enumeration, but it means callers must send the bearer token when *fetching
the card*, not just when calling RPC.

**This is non-standard.** Many A2A clients (including `@a2a-js/sdk/client`'s
`createFromUrl`) resolve the card unauthenticated first. Callers using such a
client need the card fetch itself configured with the bearer header — see
the integration test at `apps/api/src/routes/__tests__/a2a.test.ts` for a
worked example (`A2AClientFetch` wrapping `fetch` to inject the header, or a
`fetchImpl` option, depending on client version). Revisit this if it causes
enough interop friction — the alternative is a public card with no
project-identifying detail.

Two more card notes:

- Built fresh **on every request**, not cached — project name/description/
  tools edits show up immediately.
- `tenant` (the `projectId`) is set on every `AgentInterface`, and
  `DefaultRequestHandler` threads it through `ServerCallContext.tenant` into
  `PrismaA2ATaskStore` — this is the isolation Odin had to hand-roll by
  passing `(agent_id, project_id)` into every constructor.

## Making calls

### `message/send` vs `message/stream`

A coding-agent turn can run for minutes — long enough to blow past most HTTP
client timeouts on a blocking call. Two ways to avoid that, no custom
plumbing needed on either side (`SendMessageConfiguration.returnImmediately`
is part of the spec and `DefaultRequestHandler` honors it):

- **`message/stream`** — recommended. Opens an SSE connection and yields the
  full lifecycle (`task` → `statusUpdate(WORKING)` → `artifactUpdate`* →
  terminal `statusUpdate`) as it happens. This is the only way to get partial
  text/tool-call events; use it if you want to "listen to events" rather than
  just wait for a result.
- **`message/send` with `returnImmediately: true`**, then poll
  `tasks/get` — returns the task in `WORKING` as soon as it's created
  instead of blocking until the turn finishes. Poll `tasks/get` until the
  task reaches a terminal state (`COMPLETED` / `FAILED` / `CANCELED`) or
  `INPUT_REQUIRED` / `AUTH_REQUIRED`.

Plain `message/send` without `returnImmediately` blocks for the full turn
duration and is not recommended for anything but quick, low-latency
requests.

### One in-flight turn per `contextId`

Reuse the same `contextId` across `message/send`/`message/stream` calls to
get continuous conversation memory on the pod (it's hashed into a stable
`chatSessionId`). But concurrent `/agent/chat` calls on the same
`chatSessionId` **queue silently** in the runtime pod rather than erroring,
so a second task fired on a `contextId` that already has one in flight would
otherwise hang with no explanation. The executor guards this explicitly: the
second `execute()` call is rejected immediately with a JSON-RPC
`TASK_NOT_CANCELABLE` (-32002) error — not a perfect semantic fit, but the
closest existing A2A error class to "a turn is already running on this
context" without inventing a custom code. Wait for the first task to reach a
terminal or interactive (`INPUT_REQUIRED`/`AUTH_REQUIRED`) state before
sending another message on the same `contextId`.

### File input

Only inline base64 file parts are accepted today (`defaultInputModes:
['text/plain']` — no file capability advertised yet). The runtime pod only
accepts `{ type: 'file', url: 'data:<mediaType>;base64,...' }` and explicitly
does not fetch remote URLs server-side. An A2A `FilePart` carrying a `uri`
(or a raw upload) is rejected with a clear terminal error rather than
silently dropped. Fetching remote URLs server-side would need an SSRF guard
— Odin's `agents/agentic_rag/tools/a2a/ssrf.py` — which is out of scope for
v1.

## Event mapping

The runtime pod emits AI SDK `UIMessageChunk` SSE frames
(`packages/agent-runtime/src/server.ts`'s `createUIMessageStream`).
`apps/api/src/lib/a2a/event-mapper.ts` maps them onto A2A
`AgentExecutionEvent`s:

| Pod chunk | A2A event |
|---|---|
| `text-delta` | `artifactUpdate` on a single `response` artifact, `append: true` |
| `text-end` | *(nothing — `lastChunk` comes from the terminal status instead)* |
| `tool-input-available` | `statusUpdate(WORKING)` with a `DataPart` `{ toolCallId, toolName, input }` |
| `tool-output-available` | `statusUpdate(WORKING)` with `{ toolCallId, output }` |
| `tool-output-error` | `statusUpdate(WORKING)` with the error text |
| `reasoning-start/delta/end` | Suppressed by default. Surfaced as `statusUpdate(WORKING)` with `metadata.kind: 'reasoning'` only if the caller requests the `https://shogo.ai/a2a/extensions/reasoning` extension |
| `data-usage` | Accumulated, merged into the terminal status's `metadata.usage` (not its own event) |
| `data-turn-seq` | No event — persisted to `A2aTask.lastSeq` for resume bookkeeping |
| `error` | `statusUpdate(FAILED, final: true)` |
| `data-turn-complete` | `statusUpdate(COMPLETED \| CANCELED \| FAILED, final: true)` based on `data.status` — **unless** overridden (see `ask_user` below) |

Two interactive cases that need special handling, both mapping cleanly onto
existing A2A states:

- **`ask_user` tool call → `TASK_STATE_INPUT_REQUIRED`.** The agent can call
  `ask_user`, which deliberately suppresses `tool-output-available` and ends
  the turn until the user replies as the next message. Without special
  handling, the task would report `COMPLETED` with no answer captured.
  Whenever `data-turn-complete` arrives with an unanswered `ask_user` call
  pending, the mapper overrides the terminal state to `INPUT_REQUIRED`
  (using the question text as the status message) regardless of what
  `data.status` said. This needs no extra plumbing on the resume side:
  `DefaultRequestHandlerOptions.keepBusAliveStates` already defaults to
  `INPUT_REQUIRED`/`AUTH_REQUIRED`, so the event bus stays alive and a
  follow-up `message/send` on the same `taskId` resumes the conversation.
- **`data-permission-request` → `TASK_STATE_AUTH_REQUIRED`.** Only emitted
  when `SHOGO_LOCAL_MODE=true` with a non-default `strict`/`balanced`
  security policy (cloud pods and the default `full_autonomy` policy never
  hit this). The pod blocks tool execution — and the whole `/agent/chat`
  response — for up to 30s before auto-denying. This is a **transient**
  status update, not terminal: the executor surfaces it immediately (rather
  than silently eating the 30s stall) and keeps consuming the same stream,
  which resumes on its own once the pod's timeout or an operator's
  out-of-band response fires. There is intentionally no v1 path for an A2A
  client to answer this itself.

## Resuming a dropped stream (not client-visible, but worth knowing)

The Knative activator cuts pod-facing HTTP at ~5 minutes while the agent
keeps running in the pod's own buffer — a normal occurrence for any turn
that takes a while, not an edge case. If the executor's SSE read from
`/agent/chat` ends without ever seeing `data-turn-complete`, it re-fetches
`GET /agent/chat/:chatSessionId/stream?fromSeq=<lastSeq>` and keeps
publishing from there (using the mapper's own `lastSeq`, not a full replay
from 0 — since `append: true` artifact updates push new parts rather than
replacing them, a full replay would duplicate every already-published text
chunk). If that resume request comes back `204`, the pod's buffer has
expired (stop, restart, or crash) and the task is failed with a terminal
`FAILED` explaining that partial work may still be persisted. Bounded by
`CHAT_UPSTREAM_FETCH_TIMEOUT_MS` (4h default; 90s on Metal) and
`CHAT_STREAM_IDLE_TIMEOUT_MS` (1h idle-per-chunk), same env vars the regular
chat proxy uses (`project-chat.ts`).

## Billing and persistence

Going straight to the pod would bypass the usual billing/persistence path,
so the executor `tee()`s the pod's response body: one branch goes to
`mapPodChunkToA2AEvents` (published on the A2A event bus), the other to
`trackUsageFromStream` (the same function `POST /api/projects/:id/chat`
uses) for billing and `ChatMessage`/`ToolCallLog` rows. A2A turns bill and
persist exactly like UI turns — there's no separate accounting path to keep
in sync.

## Known limitations

- **`tasks/resubscribe` is same-replica only.** It relies on the SDK's
  in-process `DefaultExecutionEventBusManager`, so a resubscribe only
  succeeds if it lands on the same `apps/api` replica that ran the original
  `message/stream`. Behind a load balancer with multiple replicas, a
  resubscribe routed elsewhere will not find the bus. A future phase could
  back this with the pod's own durable replay
  (`GET /agent/chat/:id/stream?fromSeq=N` + `StreamBufferStore` in
  `packages/core/src/stream-buffer.ts`) via a custom event-bus manager, but
  that buffer is in-memory with a 30-minute TTL and does not survive pod
  migration either — it would narrow the gap, not close it.
- **The agent card requires auth** — see above. Non-standard for A2A
  clients that expect an unauthenticated card fetch.
- **No named-`ProjectAgent` selection.** `POST /agent/chat` has no
  `agentName` parameter, so there is nothing for A2A to route to beyond the
  single pod agent. `ProjectAgent` rows are used only as card metadata
  (name/description/tools) via a `chat`-skill fallback when no row exists.
  If per-persona A2A endpoints are wanted later, they'd target
  `/api/chat/turn` instead — a separate design.
- **No outbound A2A client.** Shogo agents cannot themselves call other A2A
  agents yet (Odin's `ExternalA2AClient` + `ssrf.py` equivalent).

## Out of scope for v1

Push notifications (`capabilities.pushNotifications: false` — the SDK's
`DefaultPushNotificationSender` + a durable `PushNotificationStore` would
make this straightforward later), gRPC/REST transports (JSON-RPC only),
extended agent card (`capabilities.extendedAgentCard` /
`getAuthenticatedExtendedAgentCard`), agent card JWS signing
(`AgentCardSignatureGenerator`), remote/uploaded file input, named-
`ProjectAgent` selection, an outbound A2A client, and any UI for key
management (API only — mint/list/revoke via the `/api/projects/:id/a2a/keys`
routes above).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `A2A_ENABLED` | unset (disabled) | Kill switch — set to `'true'` to mount `/a2a/*`. Key management under `/api` is unaffected either way |
| `SHOGO_A2A_BASE_URL` | falls back to `getFrontendUrl()`/`APP_URL` | Base URL A2A clients should use to reach this server — Odin's `BACKEND_ROOT_URL` equivalent. Used to build the card's `documentationUrl` and `supportedInterfaces[0].url` |
| `RATE_LIMIT_A2A_MAX` | `300` | Requests per window for `/a2a/*` |
| `RATE_LIMIT_A2A_WINDOW_MS` | `60000` | Rate-limit window, ms |
| `A2A_HANDLER_CACHE_MAX` | `200` | Max cached `DefaultRequestHandler`s (one per project with recent A2A traffic) held in the bounded LRU |
| `A2A_HANDLER_IDLE_TTL_MS` | `1800000` (30 min) | Idle eviction TTL for cached handlers with no active turn |
| `A2A_METAL_WAIT_MS` | `90000` | How long the executor waits for a Metal pod to wake before failing the turn |
| `CHAT_UPSTREAM_FETCH_TIMEOUT_MS` | `14400000` (4h) | Shared with the regular chat proxy — bounds the `/agent/chat` fetch |
| `CHAT_STREAM_IDLE_TIMEOUT_MS` | `3600000` (1h) | Shared with the regular chat proxy — per-chunk idle timeout while reading the SSE stream |

## Testing

`apps/api/src/lib/a2a/__tests__/*` (unit: `auth`, `card`, `event-mapper`,
`task-store`, `executor`) and
`apps/api/src/routes/__tests__/a2a.test.ts` (integration: a real
`@a2a-js/sdk/client` driving `/a2a/projects/:id/rpc` over `Bun.serve` against
a stub pod replaying a recorded SSE transcript — validates the wire protocol
without mocking it, mirroring Odin's `a2a_inbound_harness.py`). Run with
`bun test src/lib/a2a src/routes/__tests__/a2a.test.ts` from `apps/api`.

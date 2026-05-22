# @shogo-ai/sdk

The Shogo client SDK — auth, typed database access, and the LLM gateway.
Voice, email, agent-runtime, db adapters, and CLI helpers ship as
separate `@shogo-ai/*` packages but remain importable via deprecated
subpath shims here through v1.x. See [MIGRATION.md](./MIGRATION.md).

## Installation

```bash
npm install @shogo-ai/sdk
# or
bun add @shogo-ai/sdk
```

## Package family

The SDK was split in v1.6 into focused packages. All seven release in
lockstep on the `sdk-v*` tag:

| Package | Use when |
| --- | --- |
| `@shogo-ai/sdk` | Building a client (web / RN / Node consumer) |
| `@shogo-ai/core` | Server primitives — logger, OTEL, streaming, chat-message |
| `@shogo-ai/agent` | Building an agent backend on `pi-ai` / `pi-agent-core` |
| `@shogo-ai/db` | Prisma adapter wiring (PG / SQLite / libSQL) |
| `@shogo-ai/email` | Transactional email (SES / SMTP / OCI) |
| `@shogo-ai/voice` | ElevenLabs + Twilio voice infra + React/RN UI |
| `@shogo-ai/cli` | Deploy / manifest / packager helpers |

Old `@shogo-ai/sdk/<subpath>` imports keep working through back-compat
re-export shims. New code should import from the corresponding package
directly. See [MIGRATION.md](./MIGRATION.md) for the full subpath →
package map.

## Quick Start

```typescript
import { createClient } from '@shogo-ai/sdk'

const client = createClient({
  apiUrl: 'http://localhost:3000',
})

// Authentication
await client.auth.signUp({ email: 'user@example.com', password: 'secret' })
await client.auth.signIn({ email: 'user@example.com', password: 'secret' })
const user = client.auth.currentUser()

// Database operations
const todos = await client.db.todos.list({ where: { completed: false } })
const todo = await client.db.todos.create({ title: 'Buy milk' })
await client.db.todos.update(todo.id, { completed: true })
await client.db.todos.delete(todo.id)
```

## Features

| Feature | Lives in |
| --- | --- |
| **Authentication** — email/password with Better Auth | `@shogo-ai/sdk` (`client.auth`) |
| **Database client** — MongoDB-style CRUD with `client.db.<resource>` | `@shogo-ai/sdk` (`client.db`) |
| **LLM Gateway** — drop-in Vercel AI SDK provider | `@shogo-ai/sdk` (`client.llm`) |
| **Machines & external triggers** — pair desktops + VPS workers, pin projects for webhooks | `@shogo-ai/sdk` (`client.machines`) |
| **Project clone / sync** — pull a project's workspace cloud→local, push edits back | `@shogo-ai/sdk` (`client.projects`) |
| **Memory** — SQLite FTS5 + TF-IDF over per-user markdown | `@shogo-ai/sdk/memory` |
| **Voice** — ElevenLabs convai proxy + React hooks | [`@shogo-ai/voice`](../voice) (also as `@shogo-ai/sdk/voice/*`) |
| **Email** — SMTP / SES / OCI providers + templates | [`@shogo-ai/email`](../email) (also as `@shogo-ai/sdk/email/server`) |
| **Prisma adapters** — PG / SQLite / libSQL auto-detection | [`@shogo-ai/db`](../db) (also as `@shogo-ai/sdk/db`) |
| **Agent runtime** — `runAgentLoop`, model router, hooks | [`@shogo-ai/agent`](../agent) (also as `@shogo-ai/sdk/agent-loop` etc.) |
| **TypeScript** | Full type safety with generics |
| **Cross-Platform** | Browsers, Node, Bun, React Native |

The right column tells you where the implementation lives in v1.6+;
either path works at the import site.

## API Reference

### Client Setup

```typescript
import { createClient } from '@shogo-ai/sdk'

const client = createClient({
  apiUrl: 'http://localhost:3000',  // Your app backend URL
  auth: {
    mode: 'headless',                // 'managed' or 'headless'
    authPath: '/api/auth',           // Auth endpoint path (default)
  },
})
```

### Authentication

```typescript
// Sign up
const user = await client.auth.signUp({
  email: 'user@example.com',
  password: 'secret',
  name: 'Jane Doe',  // optional
})

// Sign in
const user = await client.auth.signIn({
  email: 'user@example.com',
  password: 'secret',
})

// Get current user (sync)
const user = client.auth.currentUser()

// Get session (async)
const session = await client.auth.getSession()

// Sign out
await client.auth.signOut()

// Listen to auth state changes
const unsubscribe = client.auth.onAuthStateChanged((state) => {
  console.log('Auth state:', state.isAuthenticated, state.user)
})
```

### Database Operations

```typescript
// List with filtering
const todos = await client.db.todos.list({
  where: { status: 'active' },
  orderBy: { createdAt: 'desc' },
  take: 20,
  skip: 0,
})

// List with query parameters (sent as URL query params)
// Example: GET /api/v2/projects?workspaceId=abc123&status=active
const projects = await client.db.projects.list({
  where: { workspaceId: 'abc123', status: 'active' },
  limit: 20,
})

// You can also use the params option for additional query parameters
const filtered = await client.db.items.list({
  where: { category: 'electronics' },
  params: { sortBy: 'price', order: 'asc' },
})

// Get by ID
const todo = await client.db.todos.get('todo-123')

// Create
const newTodo = await client.db.todos.create({
  title: 'Buy milk',
  completed: false,
})

// Update
await client.db.todos.update('todo-123', {
  completed: true,
})

// Delete
await client.db.todos.delete('todo-123')

// Count
const count = await client.db.todos.count({
  where: { completed: true },
})
```

### Query Operators

```typescript
// Comparison operators
{ priority: { $gt: 5 } }     // Greater than
{ priority: { $gte: 5 } }    // Greater than or equal
{ priority: { $lt: 5 } }     // Less than
{ priority: { $lte: 5 } }    // Less than or equal
{ status: { $eq: 'active' } } // Equal
{ status: { $ne: 'done' } }   // Not equal

// Array operators
{ tags: { $in: ['urgent', 'important'] } }    // In array
{ tags: { $nin: ['archived'] } }              // Not in array

// Logical operators
{
  $and: [
    { status: 'active' },
    { priority: { $gte: 5 } },
  ]
}

{
  $or: [
    { priority: 10 },
    { status: 'urgent' },
  ]
}
```

### React Integration

```typescript
import { useState, useEffect } from 'react'
import { createClient, type AuthState } from '@shogo-ai/sdk'

const client = createClient({ apiUrl: 'http://localhost:3000' })

function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    isAuthenticated: false,
    isLoading: true,
  })

  useEffect(() => {
    return client.auth.onAuthStateChanged(setState)
  }, [])

  return {
    ...state,
    signIn: client.auth.signIn.bind(client.auth),
    signUp: client.auth.signUp.bind(client.auth),
    signOut: client.auth.signOut.bind(client.auth),
  }
}
```

### React Native

```typescript
import { createClient, AsyncStorageAdapter } from '@shogo-ai/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'

const client = createClient({
  apiUrl: 'https://my-app.example.com',
  storage: new AsyncStorageAdapter(AsyncStorage),
})
```

## Type Safety

Use `createTypedClient` for full type inference:

```typescript
import { createTypedClient } from '@shogo-ai/sdk'

interface Todo {
  id: string
  title: string
  completed: boolean
}

interface User {
  id: string
  email: string
  name: string
}

const client = createTypedClient<{
  todos: Todo
  users: User
}>({
  apiUrl: 'http://localhost:3000',
})

// Now fully typed!
const todos: Todo[] = await client.db.todos.list()
const user: User | null = await client.db.users.get('123')
```

## Email (Server-Side)

> **Moved.** This module now lives in
> [`@shogo-ai/email`](../email/README.md). The
> `@shogo-ai/sdk/email/server` import path shown below continues to
> work via a deprecated re-export shim. New code should import from
> `@shogo-ai/email/server` directly.

The SDK includes a server-side email module for sending transactional emails via SMTP or AWS SES.

### Setup

```bash
# For SMTP (works with SES SMTP, SendGrid, Mailgun, etc.)
npm install nodemailer

# For AWS SES native API
npm install @aws-sdk/client-ses
```

### Environment Variables

```bash
# SMTP Configuration
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIA...
SMTP_PASSWORD=your-password
EMAIL_FROM=noreply@yourapp.com

# OR AWS SES Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
EMAIL_FROM=noreply@yourapp.com
```

### Usage

```typescript
// In server functions or API routes
import { createEmail } from '@shogo-ai/sdk/email/server'

// Auto-configured from environment variables
const email = createEmail()

// Send a templated email (built-in templates: welcome, password-reset, invitation, notification)
await email.sendTemplate({
  to: 'user@example.com',
  template: 'welcome',
  data: { name: 'Alice', appName: 'MyApp' },
})

// Send a raw email
await email.send({
  to: 'user@example.com',
  subject: 'Hello!',
  html: '<h1>Hello World</h1>',
})

// Register custom templates
email.registerTemplate({
  name: 'order-confirmation',
  subject: 'Order #{{orderId}} Confirmed',
  html: '<h1>Thanks for your order, {{name}}!</h1><p>Order: {{orderId}}</p>',
})

await email.sendTemplate({
  to: 'customer@example.com',
  template: 'order-confirmation',
  data: { name: 'Bob', orderId: '12345' },
})
```

### Built-in Templates

| Template | Variables |
|----------|-----------|
| `welcome` | `name`, `appName`, `loginUrl?` |
| `password-reset` | `name?`, `appName`, `resetUrl`, `expiresIn?` |
| `invitation` | `inviterName`, `resourceName`, `role?`, `acceptUrl`, `appName` |
| `notification` | `title`, `message`, `actionUrl?`, `actionText?`, `appName` |

### Explicit Configuration

```typescript
// SMTP with explicit config
const email = createEmail({
  config: {
    provider: 'smtp',
    defaultFrom: 'noreply@myapp.com',
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      user: 'username',
      password: 'password',
    },
  },
})

// AWS SES with explicit config
const email = createEmail({
  config: {
    provider: 'ses',
    defaultFrom: 'noreply@myapp.com',
    ses: {
      region: 'us-east-1',
      // credentials optional if using IAM role
    },
  },
})
```

### Optional Email (Graceful Degradation)

```typescript
import { createEmailOptional } from '@shogo-ai/sdk/email/server'

const email = createEmailOptional()

if (email) {
  await email.sendTemplate({ ... })
} else {
  console.log('Email not configured, skipping')
}
```

## Memory (Server-Side)

Fast, local per-user memory backed by SQLite FTS5 and in-process TF-IDF. No embedding API calls, no vector DB — retrieval runs in single-digit milliseconds next to your webhook server. Works on Bun (`bun:sqlite`) and Node (`better-sqlite3`, optional peer dep).

### Setup

```bash
# Node
npm install better-sqlite3
# Bun — no extra install, uses built-in bun:sqlite
```

### Quickstart

```typescript
import { MemoryStore, createLlmSummarizer } from '@shogo-ai/sdk/memory'

const memory = new MemoryStore({
  dir: './memory-store',
  userId: 'user_123',
})

memory.add('User prefers window seats on long-haul flights')
memory.addDaily('Discussed refund for order #4821')

const hits = memory.search('seat preferences', { limit: 5 })
// [{ file, chunk, score, lineStart, lineEnd, matchType }]
```

### Architecture

- Facts live as bullets in `{dir}/{userId}/MEMORY.md` and daily logs in `{dir}/{userId}/memory/YYYY-MM-DD.md`.
- A SQLite index (`.memory-index.db`) auto-rebuilds on mtime change — you never call reindex manually.
- Hybrid ranking: keyword (FTS5 + BM25) and semantic (TF-IDF cosine), merged by `file:line`.

### ElevenLabs Integration

ElevenLabs voice agents are stateless. Layer this module under your webhook server to get sub-10ms retrieval for client-tool calls.

```typescript
import { serve } from 'bun'
import { MemoryStore } from '@shogo-ai/sdk/memory'
import { createMemoryHandlers } from '@shogo-ai/sdk/memory/server'

const handlers = createMemoryHandlers(({ userId }) =>
  new MemoryStore({ dir: './memory-store', userId })
)

serve({
  port: 3100,
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/retrieve') return handlers.retrieve(req)
    if (pathname === '/add') return handlers.add(req)
    if (pathname === '/ingest') return handlers.ingest(req)
    return new Response('Not Found', { status: 404 })
  },
})
```

Register client tools in ElevenLabs pointed at these endpoints:

- `retrieve_memory(query, limit?)` → `POST /retrieve { user_id, query, limit }`
- `add_memory(fact)` → `POST /add { user_id, fact }`
- (post-call webhook) → `POST /ingest { user_id, transcript, consolidate? }`

In the agent system prompt:

```md
# Memory
- At the START of every conversation, call `retrieve_memory` with the user's
  opening topic to load relevant context.
- When the user shares preferences, personal details, decisions, or follow-up
  items, call `add_memory` to persist them.
- Never ask the user to repeat information you can retrieve from memory.
```

### Post-Call Summarization

Ingest the full transcript after the call ends and let an LLM extract canonical facts:

```typescript
import { MemoryStore, createLlmSummarizer } from '@shogo-ai/sdk/memory'

const memory = new MemoryStore({
  dir: './memory-store',
  userId: 'user_123',
  summarizer: createLlmSummarizer({
    complete: async (prompt) => myLlmClient.complete(prompt),
  }),
})

await memory.ingestTranscript(transcript, { summarize: true })
// Appends one canonical bullet per extracted fact to MEMORY.md
```

### Post-Call Consolidation (merge + dedupe + resolve conflicts)

`{ summarize: true }` is extractive and append-only — it doesn't know about bullets
already in `MEMORY.md`, so duplicates and conflicting facts accumulate. Use
`{ consolidate: true }` to have the summarizer reconcile the new transcript
against the current memory and rewrite the file atomically:

```typescript
const result = await memory.ingestTranscript(transcript, { consolidate: true })
// { bullets: 7, previous: 5, unchanged: false }

// If the transcript changes "favorite color: cerulean" to turquoise, the
// stale bullet is dropped and the new one takes its place — MEMORY.md ends up
// with exactly the updated canonical set, and the search index is rebuilt.
```

How it works:

1. Existing `MEMORY.md` bullets are parsed (ISO timestamps stripped).
2. They're passed alongside the transcript to `summarizer.consolidate(...)`.
   `createLlmSummarizer` implements this automatically with a default prompt
   that merges duplicates, keeps the most recent value on conflict, and drops
   transient small talk. Override via `buildConsolidationPrompt` if needed.
3. If the summarizer returns zero parseable bullets, `MEMORY.md` is left
   untouched (`unchanged: true`) — safe to retry.
4. Otherwise the file is atomically rewritten (tmp + rename) and reindexed.

Expose this as an HTTP endpoint with the built-in handler:

```typescript
import { createMemoryHandlers } from '@shogo-ai/sdk/memory/server'

const handlers = createMemoryHandlers(({ userId }) =>
  new MemoryStore({ dir: './memory-store', userId, summarizer }),
)

// POST /ingest  { user_id, transcript, consolidate?: boolean }
// → { ok: true, bullets, previous, unchanged }
app.post('/memory/ingest', handlers.ingest)
```

### Pre-Loading with Dynamic Variables

For the lowest latency, skip the first tool call by injecting known facts before the conversation starts:

```typescript
const context = memory
  .search(opening_topic, { limit: 3 })
  .map((h) => h.chunk)
  .join('\n')

// Pass to ElevenLabs via their Overrides / Dynamic Variables API
await startElevenLabsCall({ variables: { user_context: context } })
```

### API Reference

```typescript
new MemoryStore({
  dir: string        // root; per-user subdir created automatically
  userId: string     // stable id (phone, account id, etc.)
  summarizer?: Summarizer        // required only if ingestTranscript({ summarize: true })
  createDriver?: CreateSqliteDriver  // override SQLite driver (Bun/Node auto-detected)
})

store.add(fact: string): void
store.addDaily(entry: string, date?: string): void
store.search(query: string, opts?: { limit?: number }): MemorySearchHit[]
store.readMemoryBullets(): string[]
store.ingestTranscript(
  text: string,
  opts?: { summarize?: boolean; consolidate?: boolean },
): Promise<{ bullets: number; previous: number; unchanged: boolean }>
store.close(): void
```

Low-level access is available via `MemorySearchEngine` if you need to bypass the namespaced markdown layer.

## LLM Gateway

Pass your Shogo API key (`shogo_sk_*`) to `createClient()` and the SDK
exposes a [Vercel AI SDK](https://ai-sdk.dev) provider under `client.llm`.
Shogo Cloud fronts Anthropic, OpenAI, Google, and (optionally) a local LLM —
one key, one base URL, no per-provider setup in your app.

### Install

```bash
npm install @shogo-ai/sdk ai
# @ai-sdk/openai-compatible is a direct dep of the SDK — no extra install needed
```

### Setup

```ts
import { createClient } from '@shogo-ai/sdk'

const shogo = createClient({
  apiUrl: 'http://localhost:3000',
  db: prisma,
  shogoApiKey: process.env.SHOGO_API_KEY!,     // shogo_sk_...
  // shogoCloudUrl: 'https://studio.shogo.ai', // optional override
})
```

Get a key from the **Keys** tab of your workspace in [Shogo Cloud](https://studio.shogo.ai).

### Stream a response

```ts
import { streamText } from 'ai'

const result = streamText({
  model: shogo.llm!('claude-sonnet-4-5'),
  prompt: 'Explain quantum entanglement in one paragraph.',
})

for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
```

The same `shogo.llm` handles **both Anthropic and OpenAI models** — the
Shogo Cloud proxy routes server-side based on the model id:

```ts
import { generateText } from 'ai'

const anthropic = await generateText({
  model: shogo.llm!('claude-sonnet-4-5'),
  prompt: 'hi',
})

const openai = await generateText({
  model: shogo.llm!('gpt-5.4-mini'),
  prompt: 'hi',
})
```

List available model ids with `GET /api/ai/v1/models` on Shogo Cloud (or
any authenticated Shogo backend).

### Tool calling

Tool calls flow through the proxy unchanged — Anthropic-native `tool_use`
blocks are converted to OpenAI `tool_calls` on the way out and back.

```ts
import { streamText, tool } from 'ai'
import { z } from 'zod'

const result = streamText({
  model: shogo.llm!('claude-sonnet-4-5'),
  prompt: 'What is the weather in Tokyo?',
  tools: {
    getWeather: tool({
      description: 'Get current weather for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 21 }),
    }),
  },
})
```

### Using the provider without `createClient()`

If you only need the LLM gateway (no auth, no db), import the factory
directly:

```ts
import { createShogoLlmProvider } from '@shogo-ai/sdk'
import { generateText } from 'ai'

const shogo = createShogoLlmProvider({ apiKey: process.env.SHOGO_API_KEY! })

const { text } = await generateText({
  model: shogo('claude-haiku-4-5'),
  prompt: 'Say hi',
})
```

### Loading the key asynchronously

Fetch it from secure storage (Electron keychain, React Native SecureStore,
`platform.getShogoKeyStatus()`), then install it on the client:

```ts
const shogo = createClient({ apiUrl, db: prisma })
const key = await loadKeyFromSecureStore()
shogo.setShogoApiKey(key) // shogo.llm is now non-null
```

Pass `null` to clear the provider (e.g. on sign-out).

### Notes

- Billing/tier gates live in the cloud proxy. Free/Basic plans can use
  economy-tier models (e.g. `claude-haiku-4-5`, `gpt-5.4-nano`); Pro+
  unlocks the rest. Tier-gated calls return `403 model_tier_restricted`
  which the AI SDK surfaces as an `APICallError`.
- Insufficient included usage returns `402 insufficient_credits` (legacy
  error key, kept for backwards compatibility).
- For Anthropic-native features (extended thinking, prompt caching,
  native `tool_use` blocks), call `POST /api/ai/anthropic/v1/messages`
  on the cloud directly with your Shogo key as `x-api-key`; the
  OpenAI-compatible path loses fidelity on conversion.

## Machines & external triggers

`client.machines` exposes the workspace's paired desktops + `shogo worker`
CLI sign-ins ("machines"), and lets you pin a project to a specific
machine. Once pinned, every external request that hits the canonical
project URL —

```
https://api.shogo.ai/api/projects/<projectId>/agent-proxy/...
```

— is relayed through that machine's outbound tunnel into the
`agent-runtime` running on it. This is what makes Jira webhooks, Zapier
zaps, cron jobs, etc. trigger an agent running on **your** VPS without
ever exposing an inbound port on that VPS.

See [External Triggers](https://docs.shogo.ai/docs/features/external-triggers/quickstart)
in the user docs for the end-to-end story (Studio "Run on" UI + curl
recipes). The SDK surface below is the programmatic equivalent.

### List paired machines

```ts
const machines = await client.machines.list({ workspaceId })
// → Array<{ id, name, hostname, kind: 'desktop' | 'cli_worker',
//           status: 'online' | 'heartbeat' | 'offline', ... }>

// Trimmed shape for pickers (only online ones):
const online = await client.machines.listOnline({ workspaceId })
```

### Pin a project to a machine

```ts
const vps = machines.find((m) => m.kind === 'cli_worker' && m.name === 'prod-vps-1')!

await client.machines.pinProject(projectId, {
  instanceId: vps.id,
  policy: 'pinned',   // 503 instance_offline if the worker goes down
                      // (use 'prefer' to fall back to a cloud pod)
})
```

The pin persists on `Project.preferredInstanceId` server-side, so it
survives client reloads and is honored by every cloud pod / region.

### Inspect / clear the pin

```ts
const pin = await client.machines.getProjectPin(projectId)
// → { preferredInstanceId: 'inst-xyz' | null,
//     preferredInstancePolicy: 'pinned' | 'prefer',
//     instance: { id, name, hostname, kind } | null }

await client.machines.unpinProject(projectId)  // back to cloud routing
```

### Trigger the agent from anywhere

Once the project is pinned, **any HTTP client** can drive the agent over
plain HTTPS — no SDK install required on the caller side:

```bash
curl -X POST \
  "https://api.shogo.ai/api/projects/$PROJECT_ID/agent-proxy/agent/channels/webhook/incoming" \
  -H "Authorization: Bearer $SHOGO_API_KEY" \
  -H "X-Webhook-Secret: $CHANNEL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message": "Triage Jira ticket ABC-123"}'
```

See [Webhook channel reference](https://docs.shogo.ai/docs/features/external-triggers/webhook-channel)
for the full request/response shape, sync vs. async reply modes, and
status-code matrix.

## Project clone / sync (`client.projects`)

`client.projects` is the SDK companion to `shogo project pull/push`. It uses
the cloud Files API to move a project's workspace between cloud and a local
directory — **no AWS credentials required**.

### Pull a project locally

```ts
const stats = await client.projects.pull(projectId, {
  into: './staging-snapshot',
  include: ['src/**', 'AGENTS.md', 'config.json'],
  onProgress: ({ kind, path, index, total }) => {
    console.log(`[${kind}] ${index + 1}/${total} ${path}`)
  },
})

console.log(`Pulled ${stats.downloaded} files (${stats.errors.length} errors)`)
```

The pull is atomic — files land in `<into>.shogo-pull-tmp/` first and rename
over the target on success, so a Ctrl-C mid-pull never leaves a half-populated
workspace.

### Push edits back

```ts
await client.projects.push(projectId, {
  from: './staging-snapshot',
  deleteRemote: false,   // set to true to mirror local deletions (DESTRUCTIVE)
})
```

### Low-level helpers

For ad-hoc reads/writes without a full sync, use the per-file helpers:

```ts
await client.projects.listFiles(projectId)      // Studio-style listing
await client.projects.manifest(projectId)       // full workspace manifest
await client.projects.readFile(projectId, 'src/App.tsx')
await client.projects.writeFile(projectId, 'src/App.tsx', '// new content')
await client.projects.deleteFile(projectId, 'src/old.tsx')
```

### Custom transports (edge, browser, tests)

Both `pull` and `push` accept injected `fetch` and `fs` adapters so the same
code path runs inside an edge function, a unit test, or a custom environment
that doesn't have `node:fs/promises`:

```ts
import { CloudFileTransport } from '@shogo-ai/sdk'

const transport = new CloudFileTransport({
  apiUrl: 'https://api.shogo.ai',
  apiKey: process.env.SHOGO_API_KEY!,
  projectId,
  localDir: '/virtual/fs/proj',
  fetchImpl: myCustomFetch,
  fs: myInMemoryFsAdapter,
})

await transport.downloadAll()
```

The `agent-runtime` running on a paired machine reuses this same transport
under the hood when auto-pull is enabled — see
[Cloning projects to a paired machine](https://docs.shogo.ai/docs/features/my-machines/project-pull).

## Voice (ElevenLabs convai)

> **Moved.** This module now lives in
> [`@shogo-ai/voice`](../voice/README.md). All `@shogo-ai/sdk/voice/*`
> import paths shown below (incl. `/voice`, `/voice/server`,
> `/voice/react`, `/voice/native`, `/voice/route/*`) continue to work
> via deprecated re-export shims. New code should import from
> `@shogo-ai/voice/<sub>` directly.

Turn your Shogo app into a live voice agent with two files: one server mount
and one React component. The SDK proxies to [ElevenLabs Conversational AI](https://elevenlabs.io/docs/conversational-ai/overview)
so your `ELEVENLABS_API_KEY` never touches the browser.

### What you get

- `@shogo-ai/sdk/voice` — framework-agnostic helpers (`ElevenLabsClient`, `composeAgentPrompt`, `stripAudioTags`, `AUDIO_TAGS`, expressivity block composer).
- `@shogo-ai/sdk/voice/server` — `createVoiceHandlers(...)` factory returning Web-standard `Request → Response` functions for `signedUrl`, `tts`, `agent.{create,patch,delete}`, and `audioTags`.
- `@shogo-ai/sdk/voice/react` — web React hook (`useVoiceConversation`, `useShogoVoice`, `useChatConversation`, `useShogoChat`) + `<ShogoVoiceProvider>` + `<OrganicSphere>` / `<OrganicParticles>` visualizations, all wrapping `@elevenlabs/react` (voice) and `@ai-sdk/react` (chat).
- `@shogo-ai/sdk/voice/native` — React Native (Expo) sister export with the same API surface, wrapping `@elevenlabs/react-native` and rendering visualizations through `expo-gl` + `expo-three`. See [Voice on React Native](#voice-on-react-native) below.

### Install peer deps

```bash
# Web:
npm install @elevenlabs/react three
# Add `@ai-sdk/react` and `ai` if you also want the audio-free
# `useShogoChat` / `useChatConversation` text path:
npm install @ai-sdk/react ai

# React Native (Expo):
npm install \
  @elevenlabs/react-native @livekit/react-native @livekit/react-native-webrtc \
  expo-gl expo-three three
# Add `@ai-sdk/react` and `ai` for text chat on native:
npm install @ai-sdk/react ai
```

All voice peer deps are optional from the SDK's POV — only install the
ones you actually use. Web-only consumers don't need any of the
`@elevenlabs/react-native` / Expo / LiveKit packages, and native-only
consumers don't need `@elevenlabs/react`.

### Server mount (Hono)

```typescript
import { Hono } from 'hono'
import { createVoiceHandlers } from '@shogo-ai/sdk/voice/server'
import { MemoryStore } from '@shogo-ai/sdk/memory'
import { prisma } from './db'

// Implement CompanionStore against your own Prisma schema (one row per user).
const companionStore = {
  async findByUserId(userId: string) {
    return prisma.companion.findUnique({ where: { userId } })
  },
  async create(data) {
    return prisma.companion.create({ data })
  },
  async update(userId, patch) {
    return prisma.companion.update({ where: { userId }, data: patch })
  },
  async delete(userId) {
    await prisma.companion.delete({ where: { userId } })
  },
}

const voice = createVoiceHandlers({
  apiKey: process.env.ELEVENLABS_API_KEY!,
  getUser: async (req) => await authenticate(req), // your auth layer
  companionStore,
  memoryStore: (userId) => new MemoryStore({ dir: './memory', userId }),
})

const app = new Hono()
app.get('/api/voice/signed-url',   (c) => voice.signedUrl(c.req.raw))
app.post('/api/voice/tts-preview', (c) => voice.tts(c.req.raw))
app.post('/api/voice/agent',       (c) => voice.agent.create(c.req.raw))
app.patch('/api/voice/agent',      (c) => voice.agent.patch(c.req.raw))
app.delete('/api/voice/agent',     (c) => voice.agent.delete(c.req.raw))
app.get('/api/voice/audio-tags',   (c) => voice.audioTags(c.req.raw))
```

### React hook

`@elevenlabs/react` ≥ 1.1 requires every `useConversation` caller (which
includes `useVoiceConversation` and `useShogoVoice`) to live under a
`<ConversationProvider>`. The SDK re-exports that as `ShogoVoiceProvider`
so your app never has to import from `@elevenlabs/react` directly:

```tsx
// Wrap once at the root of your app (App.tsx / layout.tsx / etc.).
import { ShogoVoiceProvider } from '@shogo-ai/sdk/voice/react'

export default function Root({ children }: { children: React.ReactNode }) {
  return <ShogoVoiceProvider>{children}</ShogoVoiceProvider>
}
```

```tsx
// Anywhere under that provider:
import { useVoiceConversation } from '@shogo-ai/sdk/voice/react'

export function VoiceButton({ characterName }: { characterName: string }) {
  const { start, end, status, isSpeaking, isListening } = useVoiceConversation({
    characterName,
  })
  const connected = status === 'connected'
  return (
    <button onClick={connected ? end : start} disabled={status === 'connecting'}>
      {connected ? (isSpeaking ? 'speaking…' : isListening ? 'listening' : 'connected') : 'start'}
    </button>
  )
}
```

Without the provider you'll see:

> `useRegisterCallbacks must be used within a ConversationProvider`

One provider per app is enough — sibling components share the same
underlying convai session context.

The hook takes care of:

- Requesting microphone permission.
- Fetching the signed URL (default: `GET /api/voice/signed-url`).
- Registering an `add_memory(fact)` client tool that POSTs to `/api/memory/add`.
- Auto-injecting `/api/memory/retrieve` results as contextual updates on each user message.
- Accumulating a plain-text transcript and POSTing it to `/api/memory/ingest` on disconnect (with a `pagehide` `sendBeacon` fallback).

Override any path or swap `onTranscript` to take full control:

```tsx
useVoiceConversation({
  characterName: 'Zix',
  signedUrlPath: '/custom/signed-url',
  autoInjectMemory: false,
  clientTools: {
    set_light_color: async ({ color }) => { await fetch(`/api/lights?c=${color}`); return 'ok' },
  },
  onTranscript: (transcript) => saveToMyBackend(transcript),
})
```

### Audio-reactive visualization (`<OrganicSphere />`)

Drop in a ready-made visualizer that pulses with the agent's voice. Adapted
from Bruno Simon's [organic-sphere](https://github.com/brunosimon/organic-sphere)
demo and wired to the same `Uint8Array` that `useVoiceConversation` exposes:

```tsx
import { OrganicSphere, useVoiceConversation } from '@shogo-ai/sdk/voice/react'

export function VoiceAvatar({ characterName }: { characterName: string }) {
  const conversation = useVoiceConversation({ characterName })
  return (
    <div style={{ width: 320, height: 320 }}>
      <OrganicSphere
        getFrequencyData={conversation.getOutputByteFrequencyData}
        active={conversation.status === 'connected'}
        lightAColor="#ff3e00"
        lightBColor="#0063ff"
      />
    </div>
  )
}
```

`getFrequencyData` is just `() => Uint8Array | null`, so the component works
with any WebAudio graph — pass `analyserNode.getByteFrequencyData` if you are
not using `useVoiceConversation`. When it returns `null` the sphere idles in
place, so you can leave the component mounted across connect/disconnect
cycles.

Requires the host app to have `three` installed (optional peer dep).

### Text chat (audio-free path)

For surfaces where opening a microphone is unwanted (mobile companions
in libraries / on transit / with kids asleep, accessibility flows,
background tabs), drive the same agent persona over a plain streaming
HTTPS POST instead of an ElevenLabs Convai websocket.

`useShogoChat` (and the lower-level `useChatConversation`) is the
audio-free sibling of `useShogoVoice`. Same auth surface
(`shogoApiKey` + `projectId` or session cookie), same client-tool
registration shape — but no `getUserMedia`, no audio context, no
websocket.

> **Status: experimental.** The hook surface may evolve before V1
> promotion. Pin a SDK version if you embed it in production.

```bash
# Add the AI SDK peer deps:
npm install @ai-sdk/react ai
```

```tsx
import { useShogoChat } from '@shogo-ai/sdk/voice/react'

function ChatBox({ shogoApiKey, projectId }: { shogoApiKey: string; projectId: string }) {
  const chat = useShogoChat({ shogoApiKey, projectId })
  const [draft, setDraft] = useState('')
  return (
    <div>
      {chat.messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role === 'user' ? 'You' : 'Agent'}: </strong>
          {m.parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('')}
        </div>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button
        disabled={chat.status === 'streaming' || !draft.trim()}
        onClick={() => {
          void chat.sendMessage(draft)
          setDraft('')
        }}
      >
        Send
      </button>
    </div>
  )
}
```

What's persistent: long-lived memory writes via the existing
`/api/memory/{add,retrieve,ingest}` endpoints. The chat route itself
is **stateless in V1** — every request re-sends the full `messages`
array. Persist `chat.messages` yourself if you want durable threads
and rehydrate via `chat.setMessages(...)` on next mount.

#### Voice + text bridge

The two hooks expose enough surface area that you can compose a
single logical conversation across both transports yourself. The
SDK does NOT merge transcripts for you — but the four primitives
you need are already there:

| Need | Surface |
| --- | --- |
| Stable id linking the two threads | `voice.conversationId` + `chat.conversationId` (consumer-supplied option) |
| Inject typed text into a live voice session | `voice.sendContextualUpdate(text)` |
| Observe each voice turn as it happens | `useShogoVoice({ onMessage })` |
| Insert a synthetic message into the text thread without a model call | `chat.appendAssistantMessage(text)` / `chat.appendUserMessage(text)` |

```tsx
import {
  ShogoVoiceProvider,
  useShogoVoice,
  useShogoChat,
} from '@shogo-ai/sdk/voice/react'

function Companion({ shogoApiKey, projectId }: { shogoApiKey: string; projectId: string }) {
  // Pick a stable conversationId for the lifetime of the screen and
  // hand it to BOTH hooks. Voice mirrors it verbatim; chat threads it
  // through the request body + URL.
  const conversationId = useMemo(() => crypto.randomUUID(), [])

  const chat = useShogoChat({ shogoApiKey, projectId, conversationId })
  const voice = useShogoVoice({
    shogoApiKey,
    projectId,
    conversationId,
    // Mirror each voice turn into the text thread so scrollback is
    // unified.
    onMessage: ({ source, message }) => {
      if (source === 'agent') chat.appendAssistantMessage(message)
      else if (source === 'user') chat.appendUserMessage(message)
    },
  })

  // When the user types while voice is active, feed the text into
  // the live voice agent as context — no model call, no extra cost.
  // Otherwise, dispatch a normal text turn.
  const send = useCallback(
    async (text: string) => {
      if (voice.status === 'connected') {
        voice.sendContextualUpdate(text)
        chat.appendUserMessage(text) // local-only echo for the bubble
        return
      }
      await chat.sendMessage(text)
    },
    [voice, chat],
  )

  return (/* your UI */)
}
```

Two things to know:

- `voice.conversationId` falls back to the convai-side id once the
  voice session connects, so even if you don't supply one yourself,
  the value is non-`null` while the voice session is live. Read
  `voice.convaiConversationId` if you specifically want the EL id
  for log correlation.
- `appendUserMessage` / `appendAssistantMessage` only mutate the
  local thread — they don't round-trip to the server. Use them
  for hydration and for echoing voice turns into the bubble; use
  `sendMessage` when you want the model to respond.

#### Named secondary agents

A project can have multiple named agents — one record per
`(projectId, agentName)` — declared in `shogo.config.json#agents`
and reconciled to the cloud with `bunx shogo deploy`. Voice and
chat share the SAME row per name, so:

```ts
useShogoVoice({ agentName: 'architect' })  // → voice transport
useShogoChat ({ agentName: 'architect' })  // → text transport
```

both reach the same `ProjectAgent` row's persona, model, and tool
allowlist. Voice-bearing entries (those with `voiceId`) get an
ElevenLabs agent provisioned lazily on first signed-URL request;
chat-only entries omit `voiceId` and pay nothing for unused voice.

Tools may be declared as bare names (legacy sugar) OR as full
`{ name, description?, inputSchema? }` descriptors. Inline descriptors
become the source of truth for BOTH modalities — the chat route
declares them to `streamText`, and `shogo deploy` forwards the
schemas to ElevenLabs as `prompt.tools` so the voice agent can also
emit `tool-call` events. Pick one form per agent; mix sugar and
descriptors freely.

```jsonc
// shogo.config.json
{
  "agents": {
    "default": {
      "systemPrompt": "You are the project's voice + text companion."
    },
    "architect": {
      "systemPrompt": "You design system architectures.",
      "tools": [
        {
          "name": "lookup_user",
          "description": "Look up a user by id",
          "inputSchema": {
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"]
          }
        },
        "set_palette"  // sugar — schema falls back to the client's
      ],
      "model": "claude-sonnet-4-5"
    },
    "narrator": {
      "systemPrompt": "You narrate system events out loud.",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "firstMessage": "Hi, I'll narrate updates."
    }
  }
}
```

```bash
# Preview the diff:
bunx shogo deploy --dry-run

# Apply (creates / updates rows; does NOT prune by default):
bunx shogo deploy

# Apply + delete cloud rows that are no longer in the manifest:
bunx shogo deploy --prune
```

Inside a warm pod (`shogo dev`), the deploy step runs automatically
on every preflight using the pod's runtime token — so iterating on
`shogo.config.json#agents` is a straight save-and-reload loop with
no separate `shogo deploy` invocation required. Errors are
non-fatal: a bad manifest warns and falls through to `bun run dev`
so a deploy hiccup never blocks local dev.

**Tool contract.** The manifest declares the tool *schemas* (or just
names); the consumer's React code provides the matching handler
implementations. Manifest schemas WIN — client-supplied schemas are
ignored when the manifest has its own:

```tsx
useShogoChat({
  agentName: 'architect',
  tools: [
    // Tells the SDK which tools this surface has handlers for.
    { name: 'lookup_user', description: 'ignored when manifest has it', inputSchema: {} },
  ],
  clientTools: { lookup_user: async ({ id }) => fetchUser(id as string) },
})
```

Tools the client did not register are dropped server-side, so the
model never tool-calls something nothing will resolve. Tools the
manifest didn't declare don't reach the model at all (server schema
is the contract).

The `default` agent is special: it's what `agentName === undefined`
resolves to. Projects predating the agents table fall back to the
legacy per-project ElevenLabs agent for `default` until `shogo
deploy` writes a row.

#### Per-user dynamic variables

Surface fields from your own user / companion store to the agent
prompt with `dynamicVariables` — values land in ElevenLabs as
`dynamic_variables` so the agent prompt can reference them via
`{{var_name}}`. The SDK's built-ins (`character_name`,
`user_context`, `conversation_id`) always win on collision.

```tsx
const v = useShogoVoice({
  agentName: 'narrator',
  dynamicVariables: {
    user_display_name: companion.displayName,
    relationship_stage: companion.stage,
    greeting_token: companion.firstMessage ?? '',
  },
})
```

Variables also need to be declared on the agent's
`dynamic_variable_placeholders` (set at deploy time) for EL to pick
up the value at session start.

### Voice on React Native

`@shogo-ai/sdk/voice/native` is the Expo / React Native sister of
`@shogo-ai/sdk/voice/react` — same hook signatures, same provider
pattern, same `<OrganicSphere>` and `<OrganicParticles>` props — so a
pod that already drives the web sphere can swap import paths without
other code changes.

```bash
# Required peers (Expo / RN only):
npm install \
  @elevenlabs/react-native \
  @livekit/react-native @livekit/react-native-webrtc \
  expo-gl expo-three three
```

> **Expo dev builds are required.** `@elevenlabs/react-native` ships
> WebRTC native modules via `@livekit/react-native`, which Expo Go
> does not bundle. Run `npx expo prebuild` and build with `eas build`
> or `expo run:ios` / `expo run:android`.

```tsx
// App.tsx — mount the provider once near the root.
import { ShogoVoiceProvider } from '@shogo-ai/sdk/voice/native'

export default function App({ children }: { children: React.ReactNode }) {
  return <ShogoVoiceProvider>{children}</ShogoVoiceProvider>
}
```

```tsx
// Anywhere under that provider:
import { Pressable, Text, View } from 'react-native'
import {
  OrganicParticles,
  useShogoVoice,
} from '@shogo-ai/sdk/voice/native'

export function VoiceAvatar() {
  const conversation = useShogoVoice()
  const active = conversation.status === 'connected'
  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 320 }}>
        <OrganicParticles
          getFrequencyData={conversation.getOutputByteFrequencyData}
          active={active}
          style={{ flex: 1 }}
        />
      </View>
      <Pressable
        onPress={active ? conversation.end : conversation.start}
        style={{ padding: 16 }}
      >
        <Text>{active ? 'End call' : 'Talk to Shogo'}</Text>
      </Pressable>
    </View>
  )
}
```

Differences from the web hook worth knowing:

- **No `getUserMedia` pre-flight.** LiveKit handles mic permissions
  internally. To present a custom denial UI, pass an explicit
  `requestPermissions` callback (e.g. wired to `expo-av`). Throw
  from the callback to abort the session before the signed-URL
  fetch leaves the device:
  ```ts
  import * as Audio from 'expo-av'
  useShogoVoice({
    requestPermissions: async () => {
      const { status } = await Audio.requestPermissionsAsync()
      if (status !== 'granted') throw new Error('Microphone denied')
    },
  })
  ```
- **No `pagehide` / `sendBeacon`.** The transcript flush hooks into
  `AppState` and POSTs via regular `fetch` when the app moves to
  the background. There's no native `sendBeacon` equivalent, so the
  request can be lost if the OS kills the process before it
  completes — for stronger durability, persist incrementally via
  the `onTranscript` callback.
- **`fetchCredentials` defaults to `'include'`** (cookie path) or
  `'omit'` (bearer path). RN apps have no concept of `same-origin`,
  which is the web default.

The visualization components render through `expo-gl` +
`expo-three` and reuse the same shaders / config / band reactivity
model as the web sphere, so visual presets you tune in a browser
playground transfer 1:1.

### Pure helpers

The framework-agnostic entry point exposes everything the server handlers use
internally, so you can build custom workflows (a "God Mode" agent that mutates
the companion, expressivity previews, etc.):

```typescript
import {
  ElevenLabsClient,
  composeAgentPrompt,
  stripAudioTags,
  AUDIO_TAGS,
  MEMORY_CLIENT_TOOLS,
} from '@shogo-ai/sdk/voice'

const el = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! })
const agentId = await el.createAgent({
  displayName: 'Russell',
  characterName: 'Architect',
  voiceId: 'voice_123',
  systemPrompt: composeAgentPrompt('You help users configure their companion.', {
    expressivity: 'off',
    memoryBlock: null,
  }),
  firstMessage: 'What would you like to change?',
  tools: MEMORY_CLIENT_TOOLS,
})
```

## Telephony (Twilio + ElevenLabs)

The SDK exposes a dual-mode `TelephonyClient` for PSTN phone numbers.
Same method surface in both modes — only the constructor differs.

### Mode B — Shogo-hosted (just a Shogo API key)

Shogo's API server owns the ElevenLabs + Twilio accounts, lazily
provisions a per-project EL agent + Twilio number on demand, and bills
the workspace's USD usage wallet.

```ts
import { createClient } from '@shogo-ai/sdk'

const shogo = createClient({
  apiUrl: 'https://api.yourapp.com',
  db: prisma,
  shogoApiKey: process.env.SHOGO_API_KEY!,
  projectId: 'b3be0bcd-a5e4-4769-95e3-f91fe78fe99d',
})

// Buy a US number in area code 415 and link it to the project's EL agent.
const { phoneNumber } = await shogo.voice.telephony!.provisionNumber({
  areaCode: '415',
})

// Call a user and bridge them to the agent.
await shogo.voice.telephony!.outboundCall({ to: '+14155559999' })

// Recent usage (aggregated by direction).
await shogo.voice.telephony!.getUsage()
```

Browser voice uses the same Shogo key — no session cookie required:

```tsx
useVoiceConversation({
  characterName: 'Ari',
  shogoApiKey: process.env.NEXT_PUBLIC_SHOGO_API_KEY!,
  projectId: 'b3be0bcd-...',
})
```

### Mode A — self-hosted (BYO Twilio + ElevenLabs keys)

The SDK talks directly to Twilio REST + ElevenLabs REST using your
credentials. Shogo's API is not involved and no usage is recorded on
Shogo's side — `getUsage()` throws.

```ts
const shogo = createClient({
  apiUrl: 'https://api.yourapp.com',
  db: prisma,
  projectId: 'b3be0bcd-...',
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY!,
    agentId: 'agent_...',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID!,
    authToken:  process.env.TWILIO_AUTH_TOKEN!,
  },
})

await shogo.voice.telephony!.provisionNumber({ areaCode: '415' })
await shogo.voice.telephony!.outboundCall({ to: '+14155559999' })
```

If both a Shogo API key and direct EL/Twilio creds are supplied, Mode B
wins with a runtime warning. Drop `shogoApiKey` to force Mode A.

### Billing (Mode B)

All voice activity flows through the same `UsageEvent` /
`UsageWallet` path AI calls already use. Four action types:

- `voice_minutes_inbound` — per-call, minute-billed (rounds up).
- `voice_minutes_outbound` — per-call, minute-billed (rounds up).
- `voice_number_setup` — one-time charge when a number is provisioned.
- `voice_number_monthly` — recurring, debited nightly by the
  `voice-monthly-rebill` cron.

Rates live in `apps/api/src/config/usage-plans.ts` under
`VOICE_RAW_USD` and can be overridden per plan via
`PLAN_VOICE_RATE_OVERRIDES`. The effective rate is recorded on every
`UsageEvent.actionMetadata` for auditability.

Outbound calls refuse with HTTP 402 if the ledger can't cover at least
one minute; `provisionNumber` refuses if the ledger can't cover
`setup + monthly` upfront.

### Environment variables (Mode B only)

Required on Shogo's API server to enable Mode B:

```bash
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_WEBHOOK_SECRET=whsec_...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

Customers never paste these — Shogo owns them. No Shogo-specific
prefix; we use the conventional EL / Twilio env-var names.

### Recipe: "EZ Mode" translator overlay (voice + text)

Build a single overlay that lets a business user drive a *second*, technical
chat agent through a translator persona — via voice **or** text, sharing the
same system prompt and tools. The example below is exactly how the Shogo IDE
mounts its own EZ Mode on top of the existing chat.

The persona exposes two client-side tools:

- `send_to_chat(text)` — forward a plain-English instruction to the technical
  chat agent.
- `set_mode(mode)` — switch the chat between `"agent"` and `"plan"`.

Step 1 — one shared ElevenLabs agent:

```bash
ELEVENLABS_API_KEY=sk_... \
  bun run packages/agent-runtime/scripts/create-voice-mode-agent.ts
# → prints agent_id; save as ELEVENLABS_VOICE_MODE_AGENT_ID
```

Step 2 — mount the two routes on your API (voice signed URL + text stream):

```ts
// apps/api/src/server.ts
import { voiceRoutes } from './routes/voice'
app.route('/api', voiceRoutes())
```

Step 3 — on the browser, render the EZ Mode panel *inside your chat column*
on top of the existing `ChatPanel` and wrap both under a `ChatBridgeProvider`.
The bridge lets the EZ Mode panel drive the real chat without either
component knowing about the other; the normal `ChatPanel` stays mounted
underneath so its bridge registration (send / setMode / assistant emit)
stays live:

```tsx
import { useChatBridge, ChatBridgeProvider } from './voice-mode/ChatBridgeContext'
import { EzModeChatPanel } from './voice-mode/EzModeChatPanel'
import { EzModeToggle } from './voice-mode/EzModeToggle'

function ChatColumn({ children }: { children: React.ReactNode }) {
  const { ezModeActive } = useChatBridge()
  return (
    <View className="flex-1 relative">
      <View style={ezModeActive ? { opacity: 0 } : undefined}>
        {children /* regular ChatPanel */}
      </View>
      {ezModeActive && (
        <View className="absolute inset-0 z-10 bg-background">
          <EzModeChatPanel />
        </View>
      )}
    </View>
  )
}

export function ProjectLayout() {
  return (
    <ChatBridgeProvider>
      {/* Small pill that flips the chat column into EZ Mode */}
      {Platform.OS === 'web' && <EzModeToggle />}
      <ChatColumn>
        <ChatPanel /* calls useChatBridgeRegistrar inside */ />
      </ChatColumn>
    </ChatBridgeProvider>
  )
}
```

Inside the EZ Mode panel, the SDK's `useVoiceConversation` handles the voice
session and `@ai-sdk/react`'s `useChat` (pointed at `/api/voice/translator/chat`)
handles the text session. Both call the same `createBridgeClientTools(bridge)`
so their effects on the main chat are identical.

## Examples

See the [examples](./examples) directory for complete working examples:

- [todo-app](./examples/todo-app) - Full-featured todo application with auth and CRUD

## License

MIT

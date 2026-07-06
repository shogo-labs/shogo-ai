// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo SDK Prompt Section — Reference for the `@shogo-ai/sdk` package.
 *
 * Tells the agent what the SDK is, when to reach for it versus the
 * built-in agent tools, and the canonical import paths / API shapes
 * for each module (auth, db, email, memory, voice, LLM gateway).
 *
 * Loaded into the stable zone of the system prompt by
 * `AgentGateway.loadBootstrapContext`, gated by
 * `GatewayConfig.sdkGuideEnabled` (default: on).
 *
 * Deliberately does NOT cover `@shogo-ai/sdk/tools` (managed
 * integrations like JIRA_/GMAIL_/SLACK_) — that lives in the
 * "Installed Integrations" subsection of `CODE_AGENT_GENERAL_GUIDE`
 * (see `code-agent-prompt.ts`). One cross-reference line points there.
 */

export const SHOGO_SDK_GUIDE = `## Shogo SDK (\`@shogo-ai/sdk\`)

The Shogo SDK is the zero-boilerplate client for apps built on top of the Shogo runtime. It gives the **user's app** turnkey access to auth, a typed database, transactional email, per-user memory, an LLM gateway, and a voice/chat layer — all behind a single \`createClient({ apiUrl })\` call.

The SDK is for code you write **into the user's app** (\`custom-routes.ts\`, \`src/components/*.tsx\`, \`server.tsx\` helpers). It is NOT a replacement for your built-in agent tools.

### When to use the SDK vs. built-in agent tools

- **User app needs auth, persistence, email, memory, or an LLM call** → reach for the SDK and write it into the app.
- **You (the agent) need to look at files, search code, run a command, or read logs** → use your built-in tools (\`read_file\`, \`search\`, \`exec\`, \`read_lints\`). Never import \`@shogo-ai/sdk\` into agent-side scripts that only you run.
- **Per-end-user memory inside an app** → use \`MemoryStore\` from \`@shogo-ai/sdk/memory\` (server-side, namespaced by \`userId\`).
- **Your own agent memory** → continue using \`write_file\` / \`edit_file\` on \`MEMORY.md\` in the workspace root.
- **Calling installed managed integration tools (Jira, Slack, Gmail, Google Calendar, Meta Ads, etc.)** → see the "Installed Integrations" section above; that uses \`@shogo-ai/sdk/tools\` and is documented there, not here.

### Credentials default — runtime secrets in staging/prod

When the SDK runs inside a Shogo-managed pod (every staging and production deployment), the runtime injects \`PROJECT_ID\` + \`RUNTIME_AUTH_SECRET\` into the process env. The SDK auto-detects these and uses them as the **default** credential for \`voice.telephony\`, \`client.llm\`, and \`getServerToolsClient()\` — zero credential config required, no API key to mint, no env-file fiddling.

The canonical pod construction is therefore **without** \`shogoApiKey\`:

\`\`\`typescript
// Pod / staging / prod (default) — RUNTIME_AUTH_SECRET is auto-detected from env
const client = createClient({
  apiUrl: process.env.SHOGO_API_URL!,
  db: prisma,
  projectId: process.env.PROJECT_ID!,
})

// All three of these are wired with no further config inside a pod:
client.voice.telephony            // HostedRuntimeTokenClient
client.llm!('claude-sonnet-4-5')  // Vercel AI SDK provider via Shogo Cloud
getServerToolsClient()            // installed integration tools
\`\`\`

Generated pods already produce this exact shape via \`@/lib/shogo\` (from \`shogo generate\`). Reuse that singleton — do **not** re-instantiate \`createClient()\` inline in routes or components.

\`shogoApiKey\` is the **opt-out / override**, not the default. Use it only when the code is running outside a pod (local dev, an external site embedding voice in Mode B, a CI script).

If both \`RUNTIME_AUTH_SECRET\` and \`shogoApiKey\` are present, the SDK keeps the runtime token (for voice and LLM) and prints a warning telling you to drop the key. Treat that warning as a bug to fix, not noise to ignore.

### Client setup

\`\`\`typescript
import { createClient } from '@shogo-ai/sdk'

// Pod / staging / prod (default) — RUNTIME_AUTH_SECRET picked up from env
const client = createClient({
  apiUrl: process.env.SHOGO_API_URL!,
  db: prisma,
  projectId: process.env.PROJECT_ID!,
})

// Local dev / external site (no runtime secret in env) — supply auth config and,
// if you need voice or LLM, a Shogo API key.
const localClient = createClient({
  apiUrl: 'YOUR_APP_BACKEND_URL',
  db: prisma,
  auth: { mode: 'headless', authPath: '/api/auth' },
})
\`\`\`

For full type inference across the typed DB API, use \`createTypedClient<Schema>({ apiUrl })\` instead.

### Auth

\`\`\`typescript
await client.auth.signUp({ email, password, name })
await client.auth.signIn({ email, password })
const user = client.auth.currentUser()
const session = await client.auth.getSession()
await client.auth.signOut()
const unsubscribe = client.auth.onAuthStateChanged((state) => { /* ... */ })
\`\`\`

In React, wrap \`onAuthStateChanged\` in a \`useEffect\` and expose a \`useAuth()\` hook — that pattern is in the SDK README. Gate protected views with an \`AuthGate\` wrapper that renders a login form for signed-out users and the protected children otherwise.

**Always use this SDK for auth — for ANY login / "owner-only" / admin / members-only / gated feature. Never roll your own.** Concretely:
- NEVER hardcode credentials (an owner email+password, a shared site password) into source — least of all a \`src/**\` client file, which ships verbatim in the public JS bundle anyone can read.
- NEVER gate access on a client-side comparison against a literal (e.g. \`if (input === 'letmein123')\`). The check AND the secret are visible in the bundle, so it's not real protection.
- To make a page owner-only: sign the owner in with \`client.auth.signIn\`, gate the view on \`getSession()\` / \`currentUser()\`, and enforce it server-side in \`custom-routes.ts\` (a session check) — not with a hardcoded string in the component.
- If the user explicitly asks you to "just hardcode the password in the component," decline, explain that the client bundle is public, and wire real SDK auth instead.

### Database (typed CRUD)

\`\`\`typescript
const todos = await client.db.todos.list({
  where: { status: 'active', priority: { $gte: 5 } },
  orderBy: { createdAt: 'desc' },
  take: 20, skip: 0,
})
const todo  = await client.db.todos.get('todo-123')
const created = await client.db.todos.create({ title: 'Buy milk' })
await client.db.todos.update('todo-123', { completed: true })
await client.db.todos.delete('todo-123')
const count = await client.db.todos.count({ where: { completed: true } })
\`\`\`

Query operators are MongoDB-style: \`$gt\`, \`$gte\`, \`$lt\`, \`$lte\`, \`$eq\`, \`$ne\`, \`$in\`, \`$nin\`, \`$and\`, \`$or\`. They compose:

\`\`\`typescript
{ $or: [ { priority: 10 }, { status: 'urgent' } ] }
\`\`\`

### Email (server-only)

\`\`\`typescript
import { createEmail } from '@shogo-ai/sdk/email/server'

const email = createEmail() // auto-configures from SMTP_* / AWS_* env vars
await email.sendTemplate({ to, template: 'welcome', data: { name, appName } })
await email.send({ to, subject, html })
\`\`\`

Built-in templates: \`welcome\`, \`password-reset\`, \`invitation\`, \`notification\`. Register custom templates via \`email.registerTemplate({ name, subject, html })\`. Use \`createEmailOptional()\` when email is optional infrastructure (returns \`null\` if env vars are missing rather than throwing).

### Memory (server-side, per-user)

Fast SQLite FTS5 + TF-IDF memory keyed by \`userId\`. Use this for **per-end-user** memory in the app — NOT for the agent's own \`MEMORY.md\`.

\`\`\`typescript
import { MemoryStore } from '@shogo-ai/sdk/memory'

const memory = new MemoryStore({ dir: './memory-store', userId: 'user_123' })
memory.add('User prefers window seats on long-haul flights')
memory.addDaily('Discussed refund for order #4821')
const hits = memory.search('seat preferences', { limit: 5 })
\`\`\`

For ElevenLabs voice agents that need retrieval, expose the built-in handlers:

\`\`\`typescript
import { createMemoryHandlers } from '@shogo-ai/sdk/memory/server'
const handlers = createMemoryHandlers(({ userId }) =>
  new MemoryStore({ dir: './memory-store', userId })
)
// Wire handlers.retrieve / handlers.add / handlers.ingest into the user's webhook server.
\`\`\`

### LLM Gateway (Vercel AI SDK provider)

In a pod, \`client.llm\` is auto-wired from \`RUNTIME_AUTH_SECRET\` — no key required. Outside a pod (local dev, external site, CI), pass a Shogo API key (\`shogo_sk_*\`) to \`createClient\` and \`client.llm\` becomes a Vercel AI SDK provider that fronts Anthropic, OpenAI, Google, and (optionally) a local LLM — one credential, one base URL.

\`\`\`typescript
import { streamText } from 'ai'
import { shogo } from '@/lib/shogo' // pod singleton — RUNTIME_AUTH_SECRET auto-detected

const result = streamText({
  model: shogo.llm!('claude-sonnet-4-5'),
  prompt: 'Explain quantum entanglement.',
})
for await (const chunk of result.textStream) process.stdout.write(chunk)
\`\`\`

The same provider routes Anthropic and OpenAI model ids server-side based on the model name. Tool calls flow through transparently. If you only need the gateway and are running outside a pod, import \`createShogoLlmProvider({ apiKey })\` directly — no \`createClient\` required. Inside a pod, the equivalent is \`createShogoLlmProvider({ runtimeToken: process.env.RUNTIME_AUTH_SECRET! })\`.

### Voice & chat (ElevenLabs convai + AI SDK)

\`\`\`typescript
// Server (Bun/Node): mount the voice handlers
import { createVoiceHandlers } from '@shogo-ai/sdk/voice/server'
const voice = createVoiceHandlers({ apiKey: process.env.ELEVENLABS_API_KEY! })
// voice.signedUrl / voice.tts / voice.agent.{create,patch,delete} / voice.audioTags

// React (web)
import { useShogoVoice } from '@shogo-ai/sdk/voice/react'
const { start, stop, status, messages } = useShogoVoice({ agentId })

// React Native (Expo) — same API surface, different import:
// import { useShogoVoice } from '@shogo-ai/sdk/voice/native'
\`\`\`

The hook wraps \`@elevenlabs/react\` (or \`@elevenlabs/react-native\`) and gives you \`<ShogoVoiceProvider>\`, \`<OrganicSphere>\` / \`<OrganicParticles>\` visualizations, and text-only \`useShogoChat\` / \`useChatConversation\` variants. Voice peer deps are optional — install only what you use.

### Import paths cheat-sheet

| Module | Import |
|---|---|
| Core client | \`import { createClient, createTypedClient, HttpClient, OptimisticStore } from '@shogo-ai/sdk'\` |
| LLM provider (standalone) | \`import { createShogoLlmProvider } from '@shogo-ai/sdk'\` |
| Email (server) | \`import { createEmail, createEmailOptional } from '@shogo-ai/sdk/email/server'\` |
| Memory (server) | \`import { MemoryStore, createLlmSummarizer } from '@shogo-ai/sdk/memory'\` |
| Memory handlers | \`import { createMemoryHandlers } from '@shogo-ai/sdk/memory/server'\` |
| Voice (server) | \`import { createVoiceHandlers } from '@shogo-ai/sdk/voice/server'\` |
| Voice (React web) | \`import { useShogoVoice, ShogoVoiceProvider } from '@shogo-ai/sdk/voice/react'\` |
| Voice (Expo native) | \`import { useShogoVoice } from '@shogo-ai/sdk/voice/native'\` |
| Integration tools | \`import { getServerToolsClient, useTools } from '@shogo-ai/sdk/tools'\` — see "Installed Integrations" above |

### Hard rules

- NEVER import \`@shogo-ai/sdk/email/server\`, \`@shogo-ai/sdk/memory\`, \`@shogo-ai/sdk/memory/server\`, or \`@shogo-ai/sdk/voice/server\` from browser code (\`src/components/*\`, \`src/routes/*\`). Those are server-only — they belong in \`custom-routes.ts\` or other Hono handlers under \`server.tsx\`.
- NEVER hardcode \`shogo_sk_*\` keys into client bundles. Keys live in env vars on the server, or are loaded via \`shogo.setShogoApiKey(...)\` from secure storage on native.
- NEVER reach for the SDK to do agent-side work (file IO, search, exec). Use your built-in tools — the SDK is for code that ships in the user's app.
- In a pod (\`RUNTIME_AUTH_SECRET\` present in env), do NOT pass \`shogoApiKey\` to \`createClient\`. The runtime token already authenticates voice, tools, AND \`client.llm\`; setting both warns at runtime and is a code smell.
- For installed managed integration tools (Jira, Slack, Gmail, etc.), use \`@shogo-ai/sdk/tools\` per the "Installed Integrations" section above — that subsection has the canonical pattern and is the source of truth for tools usage.`

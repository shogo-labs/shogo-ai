<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# `@shogo-ai/sdk` Migration Guide

## v1.5 → v1.6 — split into focused packages

In v1.6 the monolithic `@shogo-ai/sdk` was split into seven focused
packages so each domain (agent runtime, voice, db, email, CLI helpers)
can evolve and version independently.
**No code changes are required to upgrade**: every old subpath continues
to work via deprecated re-export shims.

The shims will be removed in `@shogo-ai/sdk@2.0.0`. To prepare, swap
your imports from `@shogo-ai/sdk/<subpath>` to the new package.

### Subpath → package map

| Old subpath | New package |
| --- | --- |
| `@shogo-ai/sdk/logger` | `@shogo-ai/core/logger` |
| `@shogo-ai/sdk/instrumentation` | `@shogo-ai/core/instrumentation` |
| `@shogo-ai/sdk/stream-buffer` | `@shogo-ai/core/stream-buffer` |
| `@shogo-ai/sdk/chat-message` | `@shogo-ai/core/chat-message` |
| `@shogo-ai/sdk/macos-junk` | `@shogo-ai/core/macos-junk` |
| `@shogo-ai/sdk/tech-stack-registry` | `@shogo-ai/core/tech-stack-registry` |
| `@shogo-ai/sdk/agent-loop` | `@shogo-ai/agent/agent-loop` |
| `@shogo-ai/sdk/pi-adapter` | `@shogo-ai/agent/pi-adapter` |
| `@shogo-ai/sdk/model-catalog` | `@shogo-ai/agent/model-catalog` |
| `@shogo-ai/sdk/model-router` | `@shogo-ai/agent/model-router` |
| `@shogo-ai/sdk/tool-orchestration` | `@shogo-ai/agent/tool-orchestration` |
| `@shogo-ai/sdk/loop-detector` | `@shogo-ai/agent/loop-detector` |
| `@shogo-ai/sdk/microcompact` | `@shogo-ai/agent/microcompact` |
| `@shogo-ai/sdk/prefix-fingerprint` | `@shogo-ai/agent/prefix-fingerprint` |
| `@shogo-ai/sdk/hooks` | `@shogo-ai/agent/hooks` |
| `@shogo-ai/sdk/ai-client` | `@shogo-ai/agent/ai-client` |
| `@shogo-ai/sdk/ai-proxy` | `@shogo-ai/agent/ai-proxy` |
| `@shogo-ai/sdk/db` | `@shogo-ai/db` |
| `@shogo-ai/sdk/email` | `@shogo-ai/email` |
| `@shogo-ai/sdk/email/server` | `@shogo-ai/email/server` |
| `@shogo-ai/sdk/voice` | `@shogo-ai/voice` |
| `@shogo-ai/sdk/voice/server` | `@shogo-ai/voice/server` |
| `@shogo-ai/sdk/voice/react` | `@shogo-ai/voice/react` |
| `@shogo-ai/sdk/voice/native` | `@shogo-ai/voice/native` |
| `@shogo-ai/sdk/voice/route` | `@shogo-ai/voice/route` |
| `@shogo-ai/sdk/voice/route/signed-url` | `@shogo-ai/voice/route/signed-url` |
| `@shogo-ai/sdk/voice/route/tts-preview` | `@shogo-ai/voice/route/tts-preview` |
| `@shogo-ai/sdk/voice/route/agent` | `@shogo-ai/voice/route/agent` |
| `@shogo-ai/sdk/voice/route/audio-tags` | `@shogo-ai/voice/route/audio-tags` |
| `@shogo-ai/sdk/cli/deploy` | `@shogo-ai/cli/deploy` |
| `@shogo-ai/sdk/cli/pkg` | `@shogo-ai/cli/pkg` |

Stayed in `@shogo-ai/sdk` (no migration needed):

- `@shogo-ai/sdk` (the client surface — `createShogoClient`, types, etc.)
- `@shogo-ai/sdk/react` (`useShogo` and friends)
- `@shogo-ai/sdk/agent` (client-side agent helpers)
- `@shogo-ai/sdk/tools` / `@shogo-ai/sdk/tools/server`
- `@shogo-ai/sdk/memory` / `@shogo-ai/sdk/memory/server`
- `@shogo-ai/sdk/generators`

### Why the split

| Need | Package |
| --- | --- |
| Just the client (what most apps want) | `@shogo-ai/sdk` |
| Logger / OTEL / streaming primitives in a server | `@shogo-ai/core` |
| Build your own gateway on `pi-ai` + `pi-agent-core` | `@shogo-ai/agent` |
| Prisma adapter helpers | `@shogo-ai/db` |
| Transactional email (SES/SMTP/OCI) | `@shogo-ai/email` |
| Voice agent UI + server handlers | `@shogo-ai/voice` |
| Deploy/manifest tooling | `@shogo-ai/cli` |

### Mechanical migration

```ts
// before
import { createPrismaClient } from '@shogo-ai/sdk/db'
import { runAgentLoop } from '@shogo-ai/sdk/agent-loop'
import { useShogoVoice } from '@shogo-ai/sdk/voice/react'

// after
import { createPrismaClient } from '@shogo-ai/db'
import { runAgentLoop } from '@shogo-ai/agent/agent-loop'
import { useShogoVoice } from '@shogo-ai/voice/react'
```

Add the new packages to your `package.json`:

```bash
bun add @shogo-ai/db @shogo-ai/agent @shogo-ai/voice
```

Behavior is identical — every shim is a one-line `export *`.

### TypeScript

Editor "go to definition" on a deprecated import lands on the shim and
shows the `@deprecated` JSDoc with the new path. The TypeScript Server
will surface a `Deprecated symbol` warning in your IDE so you can spot
remaining call sites at a glance.

### Removing the shims

Track the v2 cutover in [#TODO]. The shims add ~3 KB to the published
SDK tarball; once a major release window is on the calendar, every
shim file under `packages/sdk/src/{logger,instrumentation,stream-buffer,
chat-message,agent-loop,pi-adapter,model-catalog,model-router,
tool-orchestration,loop-detector,microcompact,prefix-fingerprint,hooks,
db,email,voice,cli}/...` (and matching `tsup`/`exports` entries) is
deletable in one PR.

## v1.6 → v1.6.x — MIT carve-out from `@shogo/shared-runtime`

Four AGPL files in `@shogo/shared-runtime` were lifted to MIT inside
existing published packages (no new packages, no Docker / CI churn):

Under `@shogo-ai/agent`:

- `@shogo-ai/agent/ai-client` — Anthropic Messages API client for
  one-shot LLM calls.
- `@shogo-ai/agent/ai-proxy` — `configureAIProxy()` env helper.

Under `@shogo-ai/core`:

- `@shogo-ai/core/macos-junk` — `.DS_Store` / AppleDouble filter.
- `@shogo-ai/core/tech-stack-registry` — typed registry of first-party
  tech stacks.

`@shogo/shared-runtime` continues to re-export every one of these
symbols for AGPL workspace consumers, so no migration is required.
Apps that want MIT can switch to the canonical packages directly.

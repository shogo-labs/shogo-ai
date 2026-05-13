<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/agent

Agent-runtime primitives for backends built on
[`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) +
[`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).
This package gives you the building blocks for an agent loop without
forcing a particular gateway shape, persistence layer, or transport.

## What's included

| Subpath | What |
| --- | --- |
| `@shogo-ai/agent/agent-loop` | `runAgentLoop` — the iteration loop with loop detection, microcompaction, and tool orchestration baked in. |
| `@shogo-ai/agent/pi-adapter` | Helpers for resolving models/keys, packing/unpacking pi-ai messages, and converting between pi-agent-core's `AgentMessage` and pi-ai's `Message`. |
| `@shogo-ai/agent/model-catalog` | Authoritative model list with capabilities, pricing, tier defaults. |
| `@shogo-ai/agent/model-router` | Auto-routing between model tiers based on task complexity classification. |
| `@shogo-ai/agent/tool-orchestration` | Concurrency-safe tool dispatch (`Semaphore`, `WriteMutex`, `wrapToolsWithOrchestration`). |
| `@shogo-ai/agent/loop-detector` | Circuit breaker for tool-call/text cycles. |
| `@shogo-ai/agent/microcompact` | Inline summarization of long conversations to fit context windows. |
| `@shogo-ai/agent/prefix-fingerprint` | Deterministic hashing of system/tools/messages for prefix-cache eligibility. |
| `@shogo-ai/agent/hooks` | Event-driven hook system with two bundled defaults (`command-logger`, `session-memory`). |

## Required peers

`@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` are declared as
optional peer dependencies. Install them when you actually use the
loop, adapter, or any module that touches pi-ai types:

```bash
bun add @mariozechner/pi-ai @mariozechner/pi-agent-core
```

## License

MIT — see [LICENSE](./LICENSE).

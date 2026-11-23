<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/core

Shogo Core — generic, dependency-light utilities used across the Shogo
SDK family. Zero required peer dependencies; OpenTelemetry is opt-in.

## Subpath exports

| Subpath | What |
| --- | --- |
| `@shogo-ai/core/logger` | Structured leveled logger with pluggable sinks. |
| `@shogo-ai/core/instrumentation` | Thin OpenTelemetry tracing wrapper. Importing it requires the optional peers below; it does not no-op without them. |
| `@shogo-ai/core/stream-buffer` | In-memory ring-buffered text stream. |
| `@shogo-ai/core/chat-message` | Minimal chat-message types shared by `@shogo-ai/agent` and downstream consumers. |

## The aggregate root

`@shogo-ai/core` itself is importable with no peers installed:

```ts
import { createLogger, StreamBufferStore } from '@shogo-ai/core'
```

The root entry re-exports only modules that have no optional peers.
`@shogo-ai/core/instrumentation` is intentionally **not** part of it — its
OpenTelemetry imports are static, so re-exporting it would make
`require('@shogo-ai/core')` throw `MODULE_NOT_FOUND` for anyone who ran exactly
`npm install @shogo-ai/core`. Import the tracing helpers from the subpath.

## Optional peers

Install OpenTelemetry packages only if you import
`@shogo-ai/core/instrumentation` — the module resolves them at load time, so
importing it without them installed throws:

```bash
bun add -d @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## License

MIT — see [LICENSE](./LICENSE).

<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/core

Shogo Core — generic, dependency-light utilities used across the Shogo
SDK family. Zero required peer dependencies; OpenTelemetry is opt-in.

## Subpath exports

| Subpath | What |
| --- | --- |
| `@shogo-ai/core/logger` | Structured leveled logger with pluggable sinks. |
| `@shogo-ai/core/instrumentation` | Thin OpenTelemetry tracing wrapper that no-ops if `@opentelemetry/api` isn't installed. |
| `@shogo-ai/core/stream-buffer` | In-memory ring-buffered text stream. |
| `@shogo-ai/core/chat-message` | Minimal chat-message types shared by `@shogo-ai/agent` and downstream consumers. |

## Optional peers

Install OpenTelemetry packages only if you import
`@shogo-ai/core/instrumentation` and want real spans (otherwise the
wrapper no-ops):

```bash
bun add -d @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## License

MIT — see [LICENSE](./LICENSE).

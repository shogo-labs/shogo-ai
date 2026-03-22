// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// OTEL must initialize before any instrumented modules are imported.
// Both imports are dynamic to guarantee execution order — static imports
// would be hoisted and resolved in parallel, defeating the purpose.
// In local/desktop mode the heavy SDK packages are stripped from the bundle,
// so we skip the import entirely (the @opentelemetry/api no-ops gracefully).
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  await import('./instrumentation')
}

const server = await import('./server')
export default server.default

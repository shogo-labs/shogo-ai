// OTEL must initialize before any instrumented modules are imported.
// Both imports are dynamic to guarantee execution order — static imports
// would be hoisted and resolved in parallel, defeating the purpose.
await import('./instrumentation')

const server = await import('./server')
export default server.default

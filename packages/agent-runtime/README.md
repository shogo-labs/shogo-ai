# @shogo/agent-runtime

The Shogo agent runtime. A single compiled binary that runs in two modes:

- **Server mode** (default): the HTTP runtime served inside each agent's pod —
  agent gateway, channels, skills, S3/git sync, preview, LSP. Entry:
  [`src/server.ts`](src/server.ts).
- **Interactive mode** (`agent-runtime interactive`, or `SHOGO_INTERACTIVE=1`):
  an in-process, Claude-Code-style coding REPL that runs the agent loop against
  the current working directory and renders to the terminal. Entry dispatch is
  the first statement of `src/server.ts` (see
  [`src/interactive/`](src/interactive)). This is what the MIT `@shogo-ai/worker`
  launcher (`shogo` / `shogo chat`) spawns — it never links this package, it
  only execs the binary.

## License

**AGPL-3.0-or-later.** This applies to the whole package, including the
**interactive CLI** surface under `src/interactive/` and the compiled
`agent-runtime` binary in every mode. The interactive REPL links AGPL runtime
tools (`src/gateway-tools.ts`) directly, so the interactive binary is AGPL.

The launcher in `@shogo-ai/worker` stays MIT: it resolves and spawns this
binary as a separate OS process with inherited stdio and never imports any
code from this package.

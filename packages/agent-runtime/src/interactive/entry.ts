// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Interactive-mode entry dispatch for the agent-runtime binary.
 *
 * The same compiled binary that `shogo runtime install` ships does double
 * duty: by default it boots the HTTP runtime (`Bun.serve` in server.ts);
 * when invoked interactively it runs the in-process REPL instead.
 *
 * `server.ts` calls `maybeRunInteractive()` as its first top-level statement.
 * For the normal server path this is a no-op that returns immediately. For
 * the interactive path it dynamically imports the (Ink-pulling) REPL — kept
 * behind a dynamic import so the server boot never loads React/Ink — runs
 * it, and exits before any HTTP listener or gateway boot happens.
 */

/**
 * Pure predicate: should this process run the interactive REPL rather than
 * the HTTP server? Exposed for unit testing.
 *
 * Triggers on either:
 *   - env `SHOGO_INTERACTIVE` set to `1`/`true`, or
 *   - an `interactive` (or `chat`) positional in argv.
 */
export function isInteractiveMode(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.SHOGO_INTERACTIVE
  if (flag === '1' || flag === 'true') return true
  // slice(1) (not slice(2)) so this also works for a Bun-compiled standalone
  // binary, whose argv is [binPath, ...args] with no separate script path.
  const args = argv.slice(1)
  return args.includes('interactive') || args.includes('chat')
}

/**
 * If interactive mode is requested, run the REPL and never return (the REPL
 * calls `process.exit`). Otherwise return immediately so server boot
 * continues. Safe to `await` unconditionally at the top of server.ts.
 */
export async function maybeRunInteractive(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isInteractiveMode(argv, env)) return
  const { runInteractiveCli } = await import('./run')
  await runInteractiveCli()
  // runInteractiveCli is expected to exit on its own; this is a backstop so
  // module evaluation can never fall through to Bun.serve.
  process.exit(0)
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Interactive agent orchestration.
 *
 * Drives the in-process `AgentGateway` for both the interactive REPL and the
 * headless one-shot (`-p`) mode. The gateway is the same engine the HTTP
 * runtime uses — we just hand it a terminal `TurnStore` instead of an SSE
 * writer, so we inherit tools, permissions, MCP, plan/ask modes, compaction
 * and session management without any HTTP hop.
 *
 * `runHeadless` is dependency-injected (`gateway`, `out`, `err`) so it can be
 * unit-tested with a fake gateway and no LLM.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createTurnStore, type TurnSink } from './terminal-writer'

/** Minimal slice of `AgentGateway` the interactive layer depends on. */
export interface InteractiveGateway {
  start?(): Promise<void>
  stop?(): Promise<void>
  abortCurrentTurn?(sessionId: string): boolean
  processChatMessageStream(
    text: string,
    writer: TurnSink,
    options?: {
      modelOverride?: string
      userId?: string
      interactionMode?: 'agent' | 'plan' | 'ask'
      chatSessionId?: string
    },
  ): Promise<void>
}

/** A write-only stream sink (stdout/stderr or a test double). */
export interface OutputSink {
  write(chunk: string): unknown
}

/** Stable per-directory project id so `.shogo/` session state is reused. */
export function projectIdForCwd(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 24)
}

export interface RunHeadlessOptions {
  gateway: InteractiveGateway
  prompt: string
  sessionId: string
  out: OutputSink
  err: OutputSink
  model?: string
}

/**
 * Run a single turn and stream the assistant text to `out`, tool/diagnostic
 * activity to `err`. Resolves with a process exit code (0 ok, 1 on error).
 */
export async function runHeadless(options: RunHeadlessOptions): Promise<number> {
  const { gateway, prompt, sessionId, out, err, model } = options
  const store = createTurnStore({
    onEvent: (event) => {
      switch (event.type) {
        case 'text-delta':
          out.write(event.delta)
          break
        case 'tool-start':
          err.write(`\n[tool] ${event.toolName} running…\n`)
          break
        case 'tool-end':
          err.write(`[tool] ${event.toolCallId} ${event.status}\n`)
          break
        case 'error':
          err.write(`\n[error] ${event.text}\n`)
          break
        default:
          break
      }
    },
  })

  try {
    await gateway.processChatMessageStream(prompt, store, {
      chatSessionId: sessionId,
      interactionMode: 'agent',
      modelOverride: model,
    })
  } catch (e: any) {
    err.write(`\n[error] ${e?.message ?? e}\n`)
    return 1
  }

  out.write('\n')
  return store.hadError() ? 1 : 0
}

/** Read the `-p`/`--print` prompt from argv or `SHOGO_PRINT_PROMPT`. */
export function readPrintPrompt(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.SHOGO_PRINT_PROMPT) return env.SHOGO_PRINT_PROMPT
  // slice(1) so the `-p` flag is also found for a Bun-compiled standalone
  // binary (argv = [binPath, ...args], no separate script path).
  const args = argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--print') {
      const value = args[i + 1]
      if (value && !value.startsWith('-')) return value
      return ''
    }
    if (args[i]?.startsWith('--print=')) return args[i]!.slice('--print='.length)
  }
  return undefined
}

async function safeStop(gateway: InteractiveGateway): Promise<void> {
  try {
    await gateway.stop?.()
  } catch {
    /* best-effort */
  }
}

/**
 * Build the real in-process gateway against the CWD. Dynamically imported so
 * tests / the headless path can inject a fake instead.
 */
async function createRealGateway(cwd: string): Promise<InteractiveGateway> {
  const { AgentGateway } = await import('../gateway')
  const projectId = projectIdForCwd(cwd)
  const gateway = new AgentGateway(cwd, projectId) as unknown as InteractiveGateway
  try {
    await gateway.start?.()
  } catch (e: any) {
    // A subsystem (LSP, MCP, skills) failing to start must not brick the
    // REPL — tools are created per-turn and degrade gracefully.
    process.stderr.write(`[shogo] gateway start warning: ${e?.message ?? e}\n`)
  }
  return gateway
}

/**
 * Entry point invoked by `entry.ts` when the binary is run interactively.
 * Configures proxy billing, builds the gateway, then dispatches to headless
 * (`-p`) or the interactive REPL (Ink with a readline fallback).
 */
export async function runInteractiveCli(): Promise<void> {
  const cwd = process.env.SHOGO_INTERACTIVE_CWD || process.cwd()
  const model = process.env.SHOGO_MODEL || undefined
  const printPrompt = readPrintPrompt()
  const noTui = process.argv.includes('--no-tui') || process.env.SHOGO_NO_TUI === '1'

  // Bill all LLM traffic through the Shogo proxy using the logged-in
  // workspace key. `configureAIProxy` reads AI_PROXY_URL / AI_PROXY_TOKEN
  // (set by the launcher) and returns the provider base-URL env to apply.
  try {
    const { configureAIProxy } = await import('@shogo/shared-runtime')
    const proxy = configureAIProxy({ logPrefix: 'shogo-cli' })
    Object.assign(process.env, proxy.env)
  } catch (e: any) {
    process.stderr.write(`\n${e?.message ?? e}\n`)
    process.exit(1)
  }

  const gateway = await createRealGateway(cwd)
  const sessionId = randomUUID()

  // Headless one-shot.
  if (printPrompt !== undefined) {
    const code = await runHeadless({
      gateway,
      prompt: printPrompt,
      sessionId,
      out: process.stdout,
      err: process.stderr,
      model,
    })
    await safeStop(gateway)
    process.exit(code)
  }

  // Interactive: prefer Ink when attached to a TTY; fall back to readline.
  const wantInk = !noTui && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY)
  if (wantInk) {
    try {
      const { runInkRepl } = await import('./ui/ink-app')
      await runInkRepl({ gateway, cwd, model, sessionId })
      await safeStop(gateway)
      process.exit(0)
    } catch (e: any) {
      process.stderr.write(`\n[shogo] TUI unavailable (${e?.message ?? e}); using plain mode.\n`)
    }
  }

  const { runReadlineRepl } = await import('./ui/readline-repl')
  await runReadlineRepl({ gateway, cwd, model, sessionId })
  await safeStop(gateway)
  process.exit(0)
}

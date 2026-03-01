#!/usr/bin/env bun
/**
 * Lightweight single-eval CLI for DSPy optimization.
 *
 * Sends a single user message to a running agent-runtime server,
 * parses the SSE stream, and writes structured JSON metrics to stdout.
 *
 * Usage:
 *   bun run src/evals/run-single-eval.ts \
 *     --endpoint http://localhost:6500/agent/chat \
 *     --message "Build me a weather dashboard" \
 *     --timeout 120000
 *
 * Output (JSON on stdout):
 *   { text, toolCalls, stepCount, inputTokens, outputTokens, durationMs, error? }
 */

import { sendTurn, type ParsedAgentResponse } from './runner'

const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  const eqArg = args.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=').slice(1).join('=')
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return defaultValue
}

const endpoint = getArg('endpoint', 'http://localhost:6500/agent/chat')!
const message = getArg('message')
const timeoutMs = parseInt(getArg('timeout', '120000')!)
const agentMode = getArg('agent-mode') as 'basic' | 'advanced' | undefined
const verbose = args.includes('--verbose') || args.includes('-v')

if (!message) {
  console.error('Usage: run-single-eval.ts --endpoint URL --message TEXT [--timeout MS] [--agent-mode basic|advanced]')
  process.exit(1)
}

async function main() {
  const startTime = Date.now()

  try {
    const messages = [
      { role: 'user', parts: [{ type: 'text', text: message! }] },
    ]

    const result: ParsedAgentResponse = await sendTurn(messages, {
      agentEndpoint: endpoint,
      timeoutMs,
      verbose,
      workspaceDir: '/tmp',
      agentMode,
    })

    const durationMs = Date.now() - startTime

    const output = {
      text: result.text,
      toolCalls: result.toolCalls.map(tc => ({
        name: tc.name,
        input: tc.input,
        output: typeof tc.output === 'string' ? tc.output.substring(0, 500) : tc.output,
        error: tc.error || false,
        durationMs: tc.durationMs,
      })),
      stepCount: result.stepCount,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      durationMs,
    }

    console.log(JSON.stringify(output))
  } catch (err: any) {
    const durationMs = Date.now() - startTime
    console.log(JSON.stringify({
      text: '',
      toolCalls: [],
      stepCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: err.message || String(err),
    }))
    process.exit(1)
  }
}

main()

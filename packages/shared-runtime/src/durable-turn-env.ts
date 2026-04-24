// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified durable-turn environment variables.
 *
 * Phase 6.1: single source of truth for the env vars that control the
 * reliability behaviour of long-running agent sessions. Each runtime
 * process (API, agent-runtime, watch scripts) calls `getDurableTurnEnv()`
 * on boot and logs the resolved values, so operators can quickly verify
 * what's actually in effect and so accidental drift between services is
 * caught immediately.
 *
 * None of these variables are *required* — every one has a safe default.
 * They are documented here in one place; individual modules should import
 * the value from this module rather than reading `process.env` directly.
 */

export interface DurableTurnEnv {
  /** Feature flag for the DurableTurnRunner auto-continuation layer. */
  durableAgentTurns: boolean
  /** Max continuation attempts after the first. */
  agentMaxContinuations: number
  /** Mid-stream provider retry budget per attempt. */
  agentProviderRetries: number
  /** SIGTERM → SIGKILL grace window for the agent process. */
  agentKillGraceMs: number
  /** Alias/fallback for `agentKillGraceMs`. */
  agentDrainTimeoutMs: number
  /** SIGTERM → SIGKILL grace window for Vite. */
  viteKillGraceMs: number
  /** SSE keep-alive interval (client heartbeat). */
  streamKeepaliveMs: number
  /** Retention of on-disk stream + turn ledger entries. */
  agentStreamLedgerRetentionMs: number
  /** Watch-script SIGKILL fallback timeout (dev only). */
  watchApiKillTimeoutMs: number
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw.toLowerCase() !== 'false' && raw !== '0'
}

export function getDurableTurnEnv(): DurableTurnEnv {
  const agentKillGraceMs = num(
    'AGENT_KILL_GRACE_MS',
    num('AGENT_DRAIN_TIMEOUT_MS', 30 * 60_000),
  )
  return {
    durableAgentTurns: bool('DURABLE_AGENT_TURNS', true),
    agentMaxContinuations: num('AGENT_MAX_CONTINUATIONS', 5),
    agentProviderRetries: num('AGENT_PROVIDER_RETRIES', 2),
    agentKillGraceMs,
    agentDrainTimeoutMs: num('AGENT_DRAIN_TIMEOUT_MS', agentKillGraceMs),
    viteKillGraceMs: num('VITE_KILL_GRACE_MS', 10_000),
    streamKeepaliveMs: num('STREAM_KEEPALIVE_MS', 15_000),
    agentStreamLedgerRetentionMs: num(
      'AGENT_STREAM_LEDGER_RETENTION_MS',
      7 * 24 * 60 * 60 * 1000,
    ),
    watchApiKillTimeoutMs: num('WATCH_API_KILL_TIMEOUT_MS', 90_000),
  }
}

/**
 * Emit a single-line startup log summarizing the resolved durable-turn
 * configuration so operators/developers can quickly verify what's in
 * effect on each process.
 */
export function logDurableTurnStartup(component: string): DurableTurnEnv {
  const env = getDurableTurnEnv()
  try {
    console.log(
      `[${component}][durable-turn-env] ` +
        `durableAgentTurns=${env.durableAgentTurns} ` +
        `maxContinuations=${env.agentMaxContinuations} ` +
        `providerRetries=${env.agentProviderRetries} ` +
        `agentKillGraceMs=${env.agentKillGraceMs} ` +
        `viteKillGraceMs=${env.viteKillGraceMs} ` +
        `streamKeepaliveMs=${env.streamKeepaliveMs} ` +
        `ledgerRetentionMs=${env.agentStreamLedgerRetentionMs} ` +
        `watchApiKillMs=${env.watchApiKillTimeoutMs}`,
    )
  } catch { /* logging must never throw at startup */ }
  return env
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Limits on agent @mention chains. Kept free of imports so the e2e specs can
 * read them without loading the database client.
 */

export function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/*
 * These limits are a backstop for runaway loops, not how agents decide to
 * stop: agents are told when a tag needs no reply (TEAM_CHAT_GUIDE, the reply
 * prompt's chain context) and evals hold them to it. Keep them well above what
 * real work needs (a build/review loop runs several rounds).
 */
export const MAX_AGENT_CHAIN_DEPTH = envInt('SHOGO_AGENT_CHAIN_MAX_DEPTH', 24)
export const MAX_AGENT_TURNS_PER_THREAD = envInt('SHOGO_AGENT_CHAIN_MAX_THREAD_TURNS', 40)
/** Consecutive turns allowed between the same two agents (A→B→A→B). */
export const MAX_AGENT_PING_PONG_TURNS = envInt('SHOGO_AGENT_CHAIN_MAX_PING_PONG', 12)

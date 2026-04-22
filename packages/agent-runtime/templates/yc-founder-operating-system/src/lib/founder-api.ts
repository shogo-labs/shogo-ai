// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tiny typed client for the auto-generated CRUD routes served by server.tsx.
 *
 * The SDK generates a Hono router from prisma/schema.prisma and mounts it at
 * `/api/<kebab-plural-model>`. Each route supports list / get / create / update /
 * delete with the response shape `{ ok, items?, data? }` (see
 * packages/sdk/src/generators/routes-generator.ts).
 *
 * We intentionally hand-roll a small wrapper here instead of importing the
 * generated client so surfaces work before `bun run generate` has been run in
 * a fresh workspace — the routes may not exist yet, but the UI will just show
 * empty state (matching the "awaiting data" fallback).
 */

export interface Priority {
  id: string
  date: string
  position: number
  title: string
  outcome: string
  estimate: string
  done: boolean
}

export interface DeepWorkBlock {
  id: string
  date: string
  start: string
  end: string
  task: string
}

export interface MeetingPrep {
  id: string
  date: string
  title: string
  when: string
  prep: string
}

export interface DailyMetric {
  id: string
  date: string
  focusHours: string
  meetings: string
  openDecisions: string
  slippedYesterday: string
}

export type Verdict = 'ship' | 'revise' | 'kill'
export type Reviewer = 'ceo' | 'engineering' | 'design'

export interface Review {
  id: string
  plan: string
  reviewer: Reviewer
  verdict: Verdict
  rationale: string
  topRisk: string
  at: string
}

export interface Decision {
  id: string
  decision: string
  reasoning: string[] // decoded client-side from JSON string
  owner: string
  reversibility: 'one-way' | 'two-way'
  at: string
}

type ApiList<T> = { ok: true; items: T[] } | { ok: false; error?: { message?: string } }

async function getList<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(`/api/${path}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as ApiList<T>
    if ('ok' in body && body.ok && 'items' in body) return body.items
    return []
  } catch {
    // Routes not generated yet (fresh workspace) — return empty so the UI
    // falls back to its "awaiting data" state rather than throwing.
    return []
  }
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function listPriorities(date = todayIso()): Promise<Priority[]> {
  const items = await getList<Priority>(`priorities?date=${encodeURIComponent(date)}`)
  return items.slice().sort((a, b) => a.position - b.position)
}

export async function listDeepWorkBlocks(date = todayIso()): Promise<DeepWorkBlock[]> {
  const items = await getList<DeepWorkBlock>(`deep-work-blocks?date=${encodeURIComponent(date)}`)
  return items.slice().sort((a, b) => a.start.localeCompare(b.start))
}

export async function listMeetingPreps(date = todayIso()): Promise<MeetingPrep[]> {
  return getList<MeetingPrep>(`meeting-preps?date=${encodeURIComponent(date)}`)
}

export async function getDailyMetric(date = todayIso()): Promise<DailyMetric | null> {
  const items = await getList<DailyMetric>(`daily-metrics?date=${encodeURIComponent(date)}`)
  return items[0] ?? null
}

export async function listReviews(): Promise<Review[]> {
  const items = await getList<Review>('reviews')
  return items.slice().sort((a, b) => (a.at < b.at ? 1 : -1))
}

interface RawDecision extends Omit<Decision, 'reasoning'> {
  reasoning: string | string[]
}

export async function listDecisions(): Promise<Decision[]> {
  const raw = await getList<RawDecision>('decisions')
  return raw
    .map((d) => ({ ...d, reasoning: parseReasoning(d.reasoning) }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
}

function parseReasoning(value: string | string[]): string[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

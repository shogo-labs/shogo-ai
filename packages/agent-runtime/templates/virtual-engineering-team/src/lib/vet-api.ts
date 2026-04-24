// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tiny typed client for the auto-generated CRUD routes served by server.tsx.
 *
 * The SDK generates a Hono router from prisma/schema.prisma and mounts it at
 * `/api/<kebab-plural-model>`. Each route supports list / get / create /
 * update / delete with the response shape `{ ok, items?, data? }` (see
 * packages/sdk/src/generators/routes-generator.ts).
 *
 * Handcrafted wrappers instead of the generated client: surfaces stay usable
 * even on a fresh workspace where `bun run generate` has not been run yet —
 * missing routes just return empty lists and the UI shows its empty state.
 */

export type Stage = 'think' | 'plan' | 'build' | 'review' | 'test' | 'ship' | 'reflect'
export type SprintStatus = 'active' | 'paused' | 'shipped' | 'archived'

export interface Sprint {
  id: string
  idea: string
  stage: Stage
  status: SprintStatus
  createdAt: string
  updatedAt: string
}

export interface Artifact {
  id: string
  sprintId: string
  stage: Stage
  role: string
  kind: string
  title: string
  content: string
  createdAt: string
}

export interface SkillDoc {
  id: string
  name: string
  role: string
  stage: string
  sourceUrl: string
  sourceSha: string
  body: string
  isCore: boolean
  portedAt: string
}

export const STAGES: Stage[] = ['think', 'plan', 'build', 'review', 'test', 'ship', 'reflect']

export const STAGE_LABELS: Record<Stage, string> = {
  think:   'Think',
  plan:    'Plan',
  build:   'Build',
  review:  'Review',
  test:    'Test',
  ship:    'Ship',
  reflect: 'Reflect',
}

/** Roles spawned when a sprint enters each stage. */
export const STAGE_ROLES: Record<Stage, string[]> = {
  think:   ['host'],
  plan:    ['ceo', 'eng-mgr', 'designer'],
  build:   ['autoplan'],
  review:  ['reviewer', 'second-opinion'],
  test:    ['qa', 'investigate', 'cso'],
  ship:    ['release', 'deploy'],
  reflect: ['retro', 'memory'],
}

type ApiOk<T>   = { ok: true;  items?: T[]; data?: T }
type ApiFail    = { ok: false; error?: { message?: string } }
type ApiResp<T> = ApiOk<T> | ApiFail

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResp<T>> {
  try {
    const res = await fetch(`/api/${path}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, error: { message: `HTTP ${res.status}` } }
    return (await res.json()) as ApiResp<T>
  } catch {
    // Routes not generated yet (fresh workspace). Let callers fall back to empty state.
    return { ok: false }
  }
}

async function listAll<T>(path: string): Promise<T[]> {
  const r = await call<T>('GET', path)
  return r.ok && r.items ? r.items : []
}

async function getOne<T>(path: string): Promise<T | null> {
  const r = await call<T>('GET', path)
  return r.ok && r.data ? r.data : null
}

// ---- Sprints -----------------------------------------------------------

export async function listSprints(status?: SprintStatus): Promise<Sprint[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  const items = await listAll<Sprint>(`sprints${q}`)
  return items.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export async function getSprint(id: string): Promise<Sprint | null> {
  return getOne<Sprint>(`sprints/${encodeURIComponent(id)}`)
}

export async function createSprint(idea: string): Promise<Sprint | null> {
  const r = await call<Sprint>('POST', 'sprints', { idea, stage: 'think', status: 'active' })
  return r.ok && r.data ? r.data : null
}

export async function advanceSprint(id: string, nextStage: Stage): Promise<Sprint | null> {
  const r = await call<Sprint>('PATCH', `sprints/${encodeURIComponent(id)}`, { stage: nextStage })
  return r.ok && r.data ? r.data : null
}

export async function updateSprintStatus(id: string, status: SprintStatus): Promise<Sprint | null> {
  const r = await call<Sprint>('PATCH', `sprints/${encodeURIComponent(id)}`, { status })
  return r.ok && r.data ? r.data : null
}

// ---- Artifacts ---------------------------------------------------------

export async function listArtifactsForSprint(sprintId: string): Promise<Artifact[]> {
  const items = await listAll<Artifact>(`artifacts?sprintId=${encodeURIComponent(sprintId)}`)
  return items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

export async function createArtifact(input: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact | null> {
  const r = await call<Artifact>('POST', 'artifacts', input)
  return r.ok && r.data ? r.data : null
}

// ---- Skill docs --------------------------------------------------------

export async function listSkills(opts: { core?: boolean } = {}): Promise<SkillDoc[]> {
  const items = await listAll<SkillDoc>('skill-docs')
  const filtered = opts.core === undefined ? items : items.filter(s => s.isCore === opts.core)
  return filtered.slice().sort((a, b) => {
    if (a.isCore !== b.isCore) return a.isCore ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function getSkill(name: string): Promise<SkillDoc | null> {
  const items = await listAll<SkillDoc>(`skill-docs?name=${encodeURIComponent(name)}`)
  return items[0] ?? null
}

// ---- Helpers -----------------------------------------------------------

export function artifactsByStage(artifacts: Artifact[]): Record<Stage, Artifact[]> {
  const out: Record<Stage, Artifact[]> = {
    think: [], plan: [], build: [], review: [], test: [], ship: [], reflect: [],
  }
  for (const a of artifacts) {
    if (a.stage in out) out[a.stage as Stage].push(a)
  }
  return out
}

export function nextStage(current: Stage): Stage | null {
  const i = STAGES.indexOf(current)
  return i < 0 || i === STAGES.length - 1 ? null : STAGES[i + 1]
}

// ---- Seeding -----------------------------------------------------------

export interface SeedResult {
  created: number
  skipped: number
  failed: number
  total: number
  errors: string[]
}

/**
 * Read the bundled gstack manifest and each verbatim SKILL.md body, then
 * POST /api/skill-docs for every row not already present. Skips rows whose
 * `name` already exists so the button is safe to click multiple times.
 *
 * The heavy lifting (reading the files) happens client-side via
 * import.meta.glob in src/data/gstack-skills.ts — no filesystem access on
 * the server is required.
 */
export async function seedSkillsFromManifest(): Promise<SeedResult> {
  const { loadManifest, loadSkillBody, stripPortFrontmatter } = await import(
    '../data/gstack-skills'
  )
  const manifest = loadManifest()
  const existing = await listSkills()
  const have = new Set(existing.map((s) => s.name))

  const result: SeedResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    total: manifest.skills.length,
    errors: [],
  }

  for (const m of manifest.skills) {
    if (have.has(m.name)) {
      result.skipped++
      continue
    }
    try {
      const raw = await loadSkillBody(m.name)
      if (raw == null) {
        result.failed++
        result.errors.push(`${m.name}: body not found in bundle`)
        continue
      }
      const body = stripPortFrontmatter(raw)
      const res = await call<SkillDoc>('POST', 'skill-docs', {
        name: m.name,
        role: m.role,
        stage: m.stage,
        sourceUrl: m.sourceUrl,
        sourceSha: m.sourceSha,
        body,
        isCore: m.isCore,
        portedAt: m.portedAt,
      })
      if (!res.ok) {
        result.failed++
        result.errors.push(`${m.name}: ${res.error?.message ?? 'unknown error'}`)
      } else {
        result.created++
      }
    } catch (e) {
      result.failed++
      result.errors.push(`${m.name}: ${(e as Error).message}`)
    }
  }
  return result
}

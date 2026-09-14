#!/usr/bin/env bun
/**
 * Re-title projects that still have the creation placeholder.
 *
 * Safe by default: without --apply this only calls the title endpoint in
 * preview mode and never writes the database. Applying requires the explicit
 * ALLOW_PROD_TITLE_BACKFILL=1 guard. The production Kubernetes query is the
 * default; use TITLE_BACKFILL_DATABASE_URL only for an explicitly supplied
 * read/write-compatible Postgres connection.
 *
 * Examples:
 *   TITLE_BACKFILL_DATABASE_URL=... TITLE_API_URL=https://studio... bun scripts/backfill-project-titles.ts
 *   ... ALLOW_PROD_TITLE_BACKFILL=1 bun scripts/backfill-project-titles.ts --apply --limit 100
 */
import { spawnSync } from 'node:child_process'

type Candidate = {
  id: string
  createdAt: string
  updatedAt: string
  prompt: string
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function queryCandidates(): Candidate[] {
  const sql = `
SELECT row_to_json(x)
FROM (
  SELECT p.id, p."createdAt", p."updatedAt",
    first_message.content AS prompt
  FROM projects p
  JOIN LATERAL (
    SELECT m.content
    FROM chat_sessions cs
    JOIN chat_messages m ON m."sessionId" = cs.id
    WHERE cs."contextId" = p.id AND m.role = 'user'
    ORDER BY m."createdAt" ASC
    LIMIT 1
  ) first_message ON true
  WHERE p.name = 'New Project'
    AND p."createdAt" >= now() - interval '90 days'
    AND first_message.content IS NOT NULL
    AND first_message.content <> ''
  ORDER BY p."createdAt" ASC
  LIMIT ${Number.parseInt(arg('limit', '100'), 10) || 100}
) x`

  let result
  if (process.env.TITLE_BACKFILL_DATABASE_URL) {
    result = spawnSync('psql', ['-X', '-At', process.env.TITLE_BACKFILL_DATABASE_URL, '-c', sql], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } else {
    const context = process.env.KUBE_CONTEXT || 'context-cp7l2tcj76q'
    const namespace = process.env.KUBE_NAMESPACE || 'shogo-production-system'
    const pod = process.env.KUBE_POD || spawnSync(
      'kubectl',
      ['--context', context, '-n', namespace, 'get', 'pods', '-o', 'name'],
      { encoding: 'utf8' },
    ).stdout.split('\n').find((line: string) => /platform-pg-\d+/.test(line))?.replace('pod/', '').trim()
    if (!pod) throw new Error('Set DATABASE_URL or provide a reachable production Postgres pod')
    result = spawnSync(
      'kubectl',
      ['--context', context, '-n', namespace, 'exec', pod, '-c', 'postgres', '--',
        'psql', '-U', 'postgres', '-d', 'shogo', '-X', '-At', '-F', '\t',
        '-P', 'pager=off', '-c', sql],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
  }
  if (result.error) {
    throw new Error(
      `Could not query project candidates: ${result.error.message}` +
      ` (status=${result.status}, stderr=${result.stderr || ''})`,
    )
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Could not query project candidates (exit ${result.status})`,
    )
  }
  return result.stdout.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as Candidate)
}

async function generateTitle(
  candidate: Candidate,
  shouldPersist: boolean,
): Promise<{ name: string; description?: string; source?: string }> {
  const baseUrl = (process.env.TITLE_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (process.env.TITLE_API_TOKEN) headers.authorization = `Bearer ${process.env.TITLE_API_TOKEN}`
  const response = await fetch(`${baseUrl}/api/generate-project-name`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: candidate.prompt,
      ...(shouldPersist ? { projectId: candidate.id } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json() as { name?: string; description?: string; source?: string; error?: unknown }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`)
  return { name: body.name || 'New Project', description: body.description, source: body.source }
}

const apply = hasFlag('--apply')
if (apply && process.env.ALLOW_PROD_TITLE_BACKFILL !== '1') {
  throw new Error('Refusing --apply without ALLOW_PROD_TITLE_BACKFILL=1')
}

const candidates = queryCandidates()
console.log(`[title-backfill] ${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} candidates`)
let changed = 0
for (const candidate of candidates) {
  try {
    const title = await generateTitle(candidate, apply)
    console.log(`${candidate.id}\t${JSON.stringify(title.name)}\t${title.source ?? 'unknown'}`)
    if (apply && title.source === 'ai' && title.name !== 'New Project') changed++
  } catch (error) {
    console.error(`[title-backfill] ${candidate.id}:`, error instanceof Error ? error.message : error)
  }
}
console.log(`[title-backfill] ${apply ? `updated ${changed}` : 'no database writes; rerun with --apply after review'}`)

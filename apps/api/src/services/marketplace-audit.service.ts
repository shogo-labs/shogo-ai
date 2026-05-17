// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Marketplace listing version auditor.
 *
 * Phase 7 of the templates → marketplace consolidation. Before a
 * creator submits a listing for admin review, we want a fast,
 * advisory pass over the version's `workspaceSnapshot` for two
 * categories of issue:
 *
 * 1. **Secrets / credentials** — API keys, tokens, private keys, or
 *    anything that resembles a credential. False positives here are
 *    cheap; false negatives can leak a creator's keys to every
 *    installer of the listing.
 * 2. **Generic-ness** — listings shipped publicly should not be
 *    hard-coded to one creator's tenant. Hard-coded user IDs,
 *    workspace IDs, customer names, etc. are flagged as
 *    non-generic content the creator likely wants to parameterize.
 *
 * The auditor is purely **advisory**: it never changes a listing's
 * status. The creator-facing endpoint surfaces findings as
 * suggestions; submission for review always queues for human admin
 * approval regardless of audit outcome (see plan §Phase 7).
 *
 * Implementation calls Anthropic's Haiku model directly via fetch
 * (same shape used by `routes/ai-proxy.ts`). The model is asked to
 * return strict JSON which we parse + validate; any parse failure
 * results in `auditStatus: 'errored'` so the admin still sees that
 * an audit was attempted.
 */

import { prisma } from '../lib/prisma'
import { loadSnapshotFiles } from './marketplace-snapshot-storage.service'

const AUDIT_MODEL = 'claude-haiku-4-5'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MAX_SNAPSHOT_CHARS = 80_000 // Hard cap so we don't blow Haiku's context for huge listings.

export type AuditSeverity = 'low' | 'medium' | 'high'

export interface AuditFinding {
  /** Bucket the finding falls into. */
  category: 'secret' | 'non_generic' | 'other'
  severity: AuditSeverity
  /** File path the finding was observed in (relative to project root). */
  path?: string
  /** Short human-readable explanation. */
  message: string
  /** Optional excerpt of the offending content (already truncated). */
  excerpt?: string
}

export type AuditStatus = 'passed' | 'flagged' | 'errored'

export interface AuditResult {
  status: AuditStatus
  model: string
  findings: AuditFinding[]
  /** Raw model response, kept for debugging when status === 'errored'. */
  raw?: string
}

const SYSTEM_PROMPT = `You are a marketplace listing auditor for Shogo, a developer agent platform. You review the file contents of an agent listing's workspace and check for two issues:

1. SECRETS — credentials, API keys, tokens, passwords, private keys, OAuth client secrets, database connection strings with embedded credentials, .env values that look real, AWS keys, Stripe keys, GitHub tokens. Be aggressive: false positives are fine, false negatives are not.
2. NON-GENERIC content — values that are hard-coded to one specific tenant/customer and would not work for other installers: real personal names, real email addresses (other than placeholders like example@example.com), specific company URLs, hard-coded user IDs, workspace IDs, slack channel IDs, real domain names belonging to a specific business.

You will respond with ONLY a JSON object, no prose, no code fence:
{
  "findings": [
    { "category": "secret" | "non_generic" | "other",
      "severity": "low" | "medium" | "high",
      "path": "<file path or empty>",
      "message": "<short human explanation>",
      "excerpt": "<<= 200 chars of offending content, no full secrets>" }
  ]
}

If you find nothing, return { "findings": [] }. Never include a complete secret in "excerpt" — redact with "***" after the first 4 characters. Be concise.`

interface AnthropicTextBlock {
  type: 'text'
  text: string
}
interface AnthropicMessageResponse {
  content: AnthropicTextBlock[]
}

/**
 * Render a workspaceSnapshot into a prompt-friendly listing of files.
 * Skips binary files (`{ encoding: 'base64', data }`) since the model
 * can't reason about their content; their existence is reported but
 * the bytes are not included.
 */
function snapshotToPrompt(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ''
  }
  const root = snapshot as Record<string, unknown>
  const fileMap =
    root.files != null && typeof root.files === 'object' && !Array.isArray(root.files)
      ? (root.files as Record<string, unknown>)
      : root

  const parts: string[] = []
  let total = 0
  for (const [path, val] of Object.entries(fileMap)) {
    if (path === 'files') continue
    if (total >= MAX_SNAPSHOT_CHARS) {
      parts.push('\n--- TRUNCATED (snapshot too large for single audit pass) ---')
      break
    }
    let body: string
    if (typeof val === 'string') {
      body = val
    } else if (val && typeof val === 'object') {
      const v = val as { encoding?: string; data?: unknown }
      if (v.encoding === 'base64') {
        body = `<binary file, ${typeof v.data === 'string' ? v.data.length : 0} base64 chars>`
      } else if (typeof v.data === 'string') {
        body = v.data
      } else {
        continue
      }
    } else {
      continue
    }
    const remaining = MAX_SNAPSHOT_CHARS - total
    const trimmed = body.length > remaining ? body.slice(0, remaining) + '\n…(truncated)' : body
    parts.push(`=== ${path} ===\n${trimmed}`)
    total += trimmed.length + path.length + 8
  }
  return parts.join('\n\n')
}

function coerceFinding(raw: unknown): AuditFinding | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const category =
    r.category === 'secret' || r.category === 'non_generic' || r.category === 'other'
      ? r.category
      : 'other'
  const severity =
    r.severity === 'low' || r.severity === 'medium' || r.severity === 'high'
      ? r.severity
      : 'medium'
  const message = typeof r.message === 'string' && r.message.length > 0 ? r.message : null
  if (!message) return null
  return {
    category,
    severity,
    path: typeof r.path === 'string' ? r.path : undefined,
    message,
    excerpt: typeof r.excerpt === 'string' ? r.excerpt.slice(0, 400) : undefined,
  }
}

/**
 * Call Haiku via the Anthropic REST API. Extracted so unit tests can
 * monkeypatch `globalThis.fetch` without going through the proxy
 * stack. We deliberately do not stream — the audit response is small
 * (sub-2 KB JSON in practice) and we need to JSON.parse the whole
 * thing anyway.
 */
async function callHaiku(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AUDIT_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = (await res.json()) as AnthropicMessageResponse
  const block = json.content?.find((b) => b.type === 'text')
  return block?.text ?? ''
}

/** Strip a leading ```json fence and trailing fence if the model added one. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
    return stripped.trim()
  }
  return trimmed
}

/**
 * Run an audit pass over a workspace snapshot. Pure function: no DB
 * writes, no side effects. The caller decides what to do with the
 * result (the creator endpoint persists it; the dry-run endpoint
 * just returns it).
 */
export async function auditWorkspaceSnapshot(snapshot: unknown): Promise<AuditResult> {
  const userContent = snapshotToPrompt(snapshot)
  if (userContent.trim().length === 0) {
    return { status: 'passed', model: AUDIT_MODEL, findings: [] }
  }
  let raw = ''
  try {
    raw = await callHaiku(SYSTEM_PROMPT, userContent)
  } catch (err) {
    return {
      status: 'errored',
      model: AUDIT_MODEL,
      findings: [],
      raw: err instanceof Error ? err.message : String(err),
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(raw))
  } catch {
    return { status: 'errored', model: AUDIT_MODEL, findings: [], raw }
  }
  const findingsRaw = (parsed as { findings?: unknown[] })?.findings
  if (!Array.isArray(findingsRaw)) {
    return { status: 'errored', model: AUDIT_MODEL, findings: [], raw }
  }
  const findings = findingsRaw.map(coerceFinding).filter((f): f is AuditFinding => f != null)
  return {
    status: findings.length > 0 ? 'flagged' : 'passed',
    model: AUDIT_MODEL,
    findings,
  }
}

/**
 * Persist an audit result onto a `MarketplaceListingVersion` row.
 * Marks the version with `auditStatus`, `auditedAt`, and
 * `auditFindings`. Always advisory — does not change the listing's
 * `status`.
 */
export async function recordVersionAudit(
  versionId: string,
  result: AuditResult,
  auditedBy: string | null,
): Promise<void> {
  await prisma.marketplaceListingVersion.update({
    where: { id: versionId },
    data: {
      auditStatus: result.status,
      auditedAt: new Date(),
      auditedBy: auditedBy ?? null,
      auditModel: result.model,
      auditFindings: result.findings as object,
    },
  })
}

/**
 * Convenience helper used by both the creator's "Run audit" endpoint
 * and the auto-run on submit-for-review. Looks up the version row,
 * runs the audit, and persists the result.
 */
export async function auditListingVersion(
  versionId: string,
  auditedBy: string | null,
): Promise<AuditResult> {
  const version = await prisma.marketplaceListingVersion.findUnique({
    where: { id: versionId },
    select: {
      workspaceSnapshot: true,
      workspaceSnapshotKey: true,
      workspaceSnapshotChecksum: true,
    },
  })
  if (!version) {
    throw new Error('version_not_found')
  }
  // Prefer the S3-backed tarball when present; fall back to the
  // legacy JSON column for rows that pre-date the S3 backfill or
  // that were created during an upload outage. The auditor only
  // cares about the file map shape, which both paths produce.
  let snapshotForAudit: unknown
  if (version.workspaceSnapshotKey) {
    try {
      snapshotForAudit = {
        files: await loadSnapshotFiles(
          version.workspaceSnapshotKey,
          version.workspaceSnapshotChecksum,
        ),
      }
    } catch (err) {
      // Don't silently audit a stale JSON snapshot when S3 is
      // misbehaving — surface the error so the admin sees
      // `auditStatus: errored` instead of a misleading `passed`.
      const result: AuditResult = {
        status: 'errored',
        model: AUDIT_MODEL,
        findings: [],
        raw: err instanceof Error ? err.message : String(err),
      }
      await recordVersionAudit(versionId, result, auditedBy)
      return result
    }
  } else {
    snapshotForAudit = version.workspaceSnapshot
  }
  const result = await auditWorkspaceSnapshot(snapshotForAudit)
  await recordVersionAudit(versionId, result, auditedBy)
  return result
}

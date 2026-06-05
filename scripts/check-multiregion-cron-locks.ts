// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard against the multi-region replication poison-pill failure mode
 * that bit `analytics_digests` on 2026-05-21 (and that the audit
 * identified as latent in `storage_usage`, `usage_wallets`, and a
 * handful of request-scoped tables).
 *
 * Failure mode
 * ------------
 * Shogo runs three OCI regions (US/EU/India) against a single logical-
 * replicated Postgres database (CNPG, PG 18,
 * `INSERT_EXISTS_ACTION=last_update_wins`). `last_update_wins` only
 * resolves PRIMARY-KEY collisions on apply; a conflict on any other
 * UNIQUE INDEX halts the apply worker until a human deletes the loser
 * row. Every API replica in every region boots the same
 * `setInterval`-based cron schedulers in `apps/api/src/server.ts`, so a
 * cron that upserts on a non-PK unique index produces two inserts with
 * different PKs but the same secondary unique key — the textbook
 * poison-pill shape.
 *
 * Two complementary checks
 * ------------------------
 *
 * 1. Cron-wrapper completeness.
 *    Every cron entry point (top-level exported `run*` in
 *    `apps/api/src/jobs/` or function invoked from a `start*Cron` /
 *    `start*Collector` `setInterval` / `setTimeout` block in
 *    `apps/api/src/server.ts`) must EITHER:
 *      (a) call `withGlobalJobLock(<jobName>, async () => { ... })`
 *          as the outermost await-target in its body, AND have an
 *          entry in `apps/api/src/lib/global-job-lock.ts`'s
 *          `KNOWN_JOB_IDS` map under the same `jobName`, OR
 *      (b) be listed in this script's `INTENTIONALLY_REGIONAL`
 *          allowlist with a justification + a `regionKeyColumn` that
 *          actually exists in `prisma/schema.prisma` AND is part of a
 *          `@@unique` on the same model.
 *
 *    The allowlist friction is intentional — it forces a human to
 *    write down WHY a cron is allowed to run in every region, and the
 *    `regionKeyColumn` proves the schema actually enforces the
 *    region-discriminated unique key the allowlist claims.
 *
 * 2. Schema-level uniques registry.
 *    Every `@unique` / `@@unique` in `prisma/schema.prisma` must be
 *    categorised in `ACCEPTED_UNIQUE_KEYS` below. New uniques fail
 *    the check until a human classifies them as one of:
 *      - `random_secret`         — random UUID/hash, collision
 *                                   impossible (api_keys.keyHash,
 *                                   sessions.token, invite_links.token)
 *      - `external_global_id`    — provider-assigned global id with a
 *                                   single ingest path (Stripe
 *                                   subscription/customer/payment ids,
 *                                   Twilio/ElevenLabs ids)
 *      - `request_scoped`        — written by user/webhook request
 *                                   handlers only; conflict possible
 *                                   on cross-region retry but rare
 *                                   enough to handle with idempotency
 *                                   work rather than leader election
 *                                   (acknowledged today, scheduled for
 *                                   a follow-up PR)
 *      - `single_tenant_upsert`  — per-workspace/per-project key
 *                                   written via `prisma.X.upsert` keyed
 *                                   on the same column from a single
 *                                   user-pinned request path
 *      - `cron_locked`           — written by an in-process cron that
 *                                   IS wrapped in `withGlobalJobLock`;
 *                                   must reference a `KNOWN_JOB_IDS`
 *                                   entry
 *      - `cron_regional`         — written by an in-process cron that
 *                                   is intentionally regional; must
 *                                   reference an `INTENTIONALLY_REGIONAL`
 *                                   entry whose `regionKeyColumn` is
 *                                   part of this unique key
 *
 * Usage
 * -----
 *   bun scripts/check-multiregion-cron-locks.ts
 *   bun scripts/check-multiregion-cron-locks.ts --quiet
 *
 * Exit code 0 on pass, 1 on any violation.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCHEMA_PATH = join(REPO_ROOT, 'prisma/schema.prisma')
const JOBS_DIR = join(REPO_ROOT, 'apps/api/src/jobs')
const SERVER_PATH = join(REPO_ROOT, 'apps/api/src/server.ts')
const STORAGE_SERVICE_PATH = join(
  REPO_ROOT,
  'apps/api/src/services/storage.service.ts',
)
const ANALYTICS_DIGEST_PATH = join(
  REPO_ROOT,
  'apps/api/src/lib/analytics-digest-collector.ts',
)
const GLOBAL_JOB_LOCK_PATH = join(
  REPO_ROOT,
  'apps/api/src/lib/global-job-lock.ts',
)

// ===========================================================================
// Allowlists (human-curated; the whole point of this script is the friction
// of adding to them).
// ===========================================================================

interface IntentionallyRegional {
  /** Exported function name that contains the cron body. */
  fn: string
  /** Source file relative to repo root, for error messages. */
  file: string
  /** Why this cron is allowed to run in every region. */
  reason: string
  /**
   * `<table>.<column>` reference; the column must exist in
   * `prisma/schema.prisma` AND be part of a `@@unique` on the same
   * model. Asserted in `checkIntentionallyRegionalSchema()`.
   */
  regionKeyColumn: string
}

const INTENTIONALLY_REGIONAL: IntentionallyRegional[] = [
  {
    fn: 'generateDigest',
    file: 'apps/api/src/lib/analytics-digest-collector.ts',
    reason:
      'Seed for genuine per-region analytics: dashboard will eventually show separate funnel numbers for US/EU/India. Folding `region` into the unique key is the contract; do not wrap in withGlobalJobLock. See schema comment on AnalyticsDigest.region for the follow-up plan (source-table region tagging).',
    regionKeyColumn: 'analytics_digests.region',
  },
]

interface UniqueKeyRule {
  /** `<model>.<col>` or `<model>.(col1,col2,…)` (composite). Sorted alpha for composites. */
  key: string
  category:
    | 'random_secret'
    | 'external_global_id'
    | 'request_scoped'
    | 'single_tenant_upsert'
    | 'cron_locked'
    | 'cron_regional'
  /** One-line justification. */
  reason: string
  /**
   * For `cron_locked`: which `KNOWN_JOB_IDS` entry writes this row.
   * For `cron_regional`: which `INTENTIONALLY_REGIONAL.fn` writes it.
   * Unused for other categories.
   */
  writer?: string
}

const ACCEPTED_UNIQUE_KEYS: UniqueKeyRule[] = [
  // --- random secrets / cryptographically-unique tokens --------------------
  {
    key: 'User.email',
    category: 'request_scoped',
    reason:
      'Better Auth signup writes from one geo-routed region per user; cross-region duplicate signup requires a race during failover. P2 — fix is idempotent signup hook, not leader election.',
  },
  {
    key: 'Session.token',
    category: 'random_secret',
    reason: 'Random session token; collision astronomically improbable.',
  },
  {
    key: 'Account.(accountId,providerId)',
    category: 'request_scoped',
    reason:
      'OAuth link via Better Auth; rare cross-region race during failover.',
  },
  {
    key: 'Workspace.slug',
    category: 'request_scoped',
    reason:
      'Workspace slug from createPersonalWorkspace/createPaidWorkspace, single-source per workspace creation; suffix uses deterministic user prefix or nanoid.',
  },
  {
    key: 'Project.publishedSubdomain',
    category: 'request_scoped',
    reason:
      'Publish flow pre-checks then updates; cross-region race possible during failover, P2 follow-up.',
  },
  {
    key: 'CustomDomain.hostname',
    category: 'request_scoped',
    reason:
      'Written by the user-initiated POST /api/projects/:id/domains handler (publish.ts); a globally-unique hostname can only collide if two users add the same domain in different regions during failover, which CF custom-hostname registration would also reject. P2 — idempotent add, not leader election.',
  },
  {
    key: 'AgentConfig.projectId',
    category: 'single_tenant_upsert',
    reason:
      'Per-project upsert keyed on `projectId`; PATCH heartbeat-settings request from one region.',
  },
  {
    key: 'WorkspaceModelVisibility.(modelId,workspaceId)',
    category: 'single_tenant_upsert',
    reason:
      'workspace-models.service.ts setAllowedModelIds deletes+recreates a workspace\'s allowlist in one transaction from an owner/admin PUT request; per-workspace, not a global/cron writer.',
  },
  {
    key: 'GitHubConnection.projectId',
    category: 'single_tenant_upsert',
    reason: 'github.service.ts:309 upserts on projectId from a user request.',
  },
  {
    key: 'StarredProject.(projectId,userId)',
    category: 'request_scoped',
    reason:
      'Mobile star-toggle; double-tap during failover is the race window. P2 — needs idempotent upsert in the route.',
  },
  {
    key: 'BillingAccount.workspaceId',
    category: 'single_tenant_upsert',
    reason: 'billing.service.ts:900 upserts on workspaceId from Stripe flow.',
  },
  {
    key: 'InviteLink.token',
    category: 'random_secret',
    reason: 'Random UUID; collision impossible in practice.',
  },
  {
    key: 'Subscription.stripeSubscriptionId',
    category: 'external_global_id',
    reason:
      'Stripe webhook is single-source per Stripe account; collision needs cross-region webhook redelivery.',
  },
  {
    key: 'Subscription.workspaceId',
    category: 'single_tenant_upsert',
    reason: 'billing.service.ts:829 upserts on workspaceId; one webhook ingest.',
  },
  {
    key: 'UsageWallet.workspaceId',
    category: 'cron_locked',
    reason:
      'Written by runGrantMonthlyRefill (cron) and billing service flows; the cron is the symmetric writer and is lock-wrapped. Request-time create-after-find race is a P1 idempotency follow-up.',
    writer: 'grant-monthly-refill',
  },
  {
    key: 'InstanceSubscription.workspaceId',
    category: 'single_tenant_upsert',
    reason:
      'instance.service.ts:68 upserts on workspaceId from Stripe webhook (single ingest).',
  },
  {
    key: 'InstanceSubscription.stripeSubscriptionId',
    category: 'external_global_id',
    reason:
      'Stripe-assigned; single webhook ingest. Same shape as Subscription.stripeSubscriptionId.',
  },
  {
    key: 'StorageUsage.workspaceId',
    category: 'cron_locked',
    reason:
      'Written by recalculateAllStorageUsage (boot + 6h cron) and only by that cron. Wrapped in withGlobalJobLock.',
    writer: 'storage-recalculate-all',
  },
  {
    key: 'TaskDependency.(blockingTaskId,dependentTaskId)',
    category: 'request_scoped',
    reason: 'No runtime writers in app code today (eval/test seed only).',
  },
  {
    key: 'ComponentDefinition.implementationRef',
    category: 'request_scoped',
    reason: 'Seed/migration DDL only; no runtime writers.',
  },
  {
    key: 'Registry.name',
    category: 'request_scoped',
    reason: 'Seed/migration DDL only; no runtime writers.',
  },
  {
    key: 'LayoutTemplate.name',
    category: 'request_scoped',
    reason: 'Seed/migration DDL only; no runtime writers.',
  },
  {
    key: 'AnalyticsDigest.(date,period,region)',
    category: 'cron_regional',
    reason:
      'Intentionally regional: every region writes its own row tagged with `REGION_ID`. Folding `region` into the key prevents the cross-region INSERT collision; the per-region semantics are the seed for genuine regional analytics (see schema comment + INTENTIONALLY_REGIONAL entry).',
    writer: 'generateDigest',
  },
  {
    key: 'SignupAttribution.userId',
    category: 'single_tenant_upsert',
    reason: 'admin.ts:744 upserts on userId from a request.',
  },
  {
    key: 'ApiKey.keyHash',
    category: 'random_secret',
    reason: 'Random key + hash; collision cryptographically impossible.',
  },
  {
    key: 'Instance.(hostname,userId,workspaceId)',
    category: 'single_tenant_upsert',
    reason:
      'instances.ts upserts on (workspaceId,userId,hostname) from instance heartbeat / WS-auth; one writer per (user,instance), scoped to the registering API key.',
  },
  {
    key: 'PushSubscription.(instanceId,pushToken)',
    category: 'single_tenant_upsert',
    reason: 'remote-audit.ts:108 upserts on (instanceId,pushToken).',
  },
  {
    key: 'CreatorProfile.userId',
    category: 'request_scoped',
    reason:
      'marketplace.service.ts:241 creates; onboarding double-submit race possible. P2 follow-up.',
  },
  {
    key: 'CreatorBadge.(badgeType,creatorId)',
    category: 'request_scoped',
    reason:
      'creator-gamification.service.ts:189 creates; non-atomic check-then-create. P2 follow-up.',
  },
  // --- Native MLM affiliate program -----------------------------------------
  {
    key: 'Affiliate.userId',
    category: 'request_scoped',
    reason:
      'affiliate.service.ts:enrollAffiliate is an opt-in user action with an idempotency early-return on findUnique({userId}); residual cross-region race during failover is P2 (caller surfaces existing row).',
  },
  {
    key: 'Affiliate.code',
    category: 'request_scoped',
    reason:
      'Caller-chosen slug at opt-in (or derived with random-suffix retry on collision); race window narrow because enrollment is an explicit user action surfaced by the mobile dashboard.',
  },
  {
    key: 'AffiliateAttribution.userId',
    category: 'request_scoped',
    reason:
      'Written exactly once by the better-auth user.create.after hook (single-region per signup) inside resolveAttributionForUser, which catches P2002 and returns the existing row.',
  },
  {
    key: 'AffiliateCommission.(affiliateId,level,stripeInvoiceId)',
    category: 'cron_locked',
    reason:
      'Written by recordCommissionsForInvoice from invoice.payment_succeeded webhook AND by runAffiliateInvoiceReconciliation cron. Both go through the same create-with-catch on P2002 path so duplicate webhook delivery or cross-region reconciliation never doubles commissions; the cron itself is lock-wrapped via affiliate-invoice-reconciliation.',
    writer: 'affiliate-invoice-reconciliation',
  },
  {
    key: 'AffiliateCommissionTier.level',
    category: 'single_tenant_upsert',
    reason:
      'Seeded by the affiliate_system migration (INSERT ON CONFLICT DO NOTHING); runtime mutations only via a future super-admin route, single ingest per change.',
  },
  {
    key: 'CreatorFollow.(creatorId,followerId)',
    category: 'request_scoped',
    reason:
      'creator-follow.service.ts uses createMany({ skipDuplicates: true }) inside a $transaction (INSERT ... ON CONFLICT DO NOTHING) for in-region idempotency. Residual P2: cross-region double-tap during failover still produces two inserts with different PKs but the same (followerId, creatorId). Structural fix is a deterministic id of `${followerId}_${creatorId}` so collisions resolve via PK last_update_wins instead of poisoning the apply worker.',
  },
  {
    key: 'MarketplaceListing.projectId',
    category: 'request_scoped',
    reason: 'marketplace.service.ts:270 creates per-project; rare race.',
  },
  {
    key: 'MarketplaceListing.slug',
    category: 'request_scoped',
    reason:
      'marketplace.service.ts:270 generates slug with nanoid suffix; collision astronomically improbable in practice.',
  },
  {
    key: 'MarketplaceListingVersion.(listingId,version)',
    category: 'request_scoped',
    reason:
      'marketplace.ts:667 creates on version push; local 409 on P2002, cross-region race during failover is the residual P2.',
  },
  {
    key: 'MarketplaceReview.(listingId,userId)',
    category: 'request_scoped',
    reason: 'marketplace.service.ts:464 creates; double-submit race. P2 follow-up.',
  },
  {
    key: 'VoiceProjectConfig.projectId',
    category: 'single_tenant_upsert',
    reason: 'voice.ts:1238 / :231 upsert on projectId from user requests.',
  },
  {
    key: 'ProjectAuthConfig.projectId',
    category: 'single_tenant_upsert',
    reason:
      'project-auth-config.service.ts upserts on projectId from a Studio PUT request (one project owner saving allowlist settings).',
  },
  {
    key: 'ProjectAuthSignIn.(projectId,userId)',
    category: 'request_scoped',
    reason:
      'project-auth-config.service.ts:recordSignIn writes from the better-auth after-hook on sign-in/sign-up — single user request per signin; cross-region duplicate sign-in is a narrow failover race, recordSignIn catches P2002 by upserting on the unique pair.',
  },
  {
    key: 'ChatSessionProject.(projectId,sessionId)',
    category: 'request_scoped',
    reason:
      'Written when a user attaches a project to a workspace-scoped chat session (generated chat-session-project route). One user request per attach; the unique pair just dedupes a double-attach of the same project to the same session.',
  },
  {
    key: 'ProjectAttachment.(attachedProjectId,projectId)',
    category: 'single_tenant_upsert',
    reason:
      'project-attachment.service.ts:attachProjectToProject upserts on the (projectId,attachedProjectId) composite from a single Folders-panel attach request (one project owner per region); detach is deleteMany on the same pair.',
  },
  {
    key: 'VoiceCallMeter.conversationId',
    category: 'request_scoped',
    reason:
      'voice-meter.ts:146 EL/Twilio webhook dedupe; cross-region webhook redelivery race. P2 follow-up.',
  },
  {
    key: 'VoiceCallMeter.callSid',
    category: 'request_scoped',
    reason: 'Same as conversationId — Twilio side of the same webhook dedupe.',
  },
  {
    key: 'VoiceCallMeter.usageEventId',
    category: 'random_secret',
    reason: 'Internal usage-event id (UUID); collision impossible.',
  },
  {
    key: 'ProjectAgent.(name,projectId)',
    category: 'request_scoped',
    reason:
      'projectAgentSync.service.ts:384 creates on deploy sync; redeploy race. P2 follow-up.',
  },
  {
    key: 'AgentCostMetric.agentRunId',
    category: 'random_secret',
    reason:
      'agentRunId is a generated unique id per subagent run; fire-and-forget create. P2 idempotency if double-close becomes a problem.',
  },
  {
    key: 'SubagentModelOverride.(agentType,projectId,workspaceId)',
    category: 'single_tenant_upsert',
    reason:
      'cost-analytics.service.ts:1217 find-then-create/update keyed on the composite; admin request path.',
  },
  {
    key: 'LicenseKey.codeHash',
    category: 'random_secret',
    reason:
      'sha-256 of a ~119-bit random plaintext minted in license-key.service.ts:mintCode; collision cryptographically impossible.',
  },
  {
    key: 'LicenseKey.redeemedByWorkspaceId',
    category: 'request_scoped',
    reason:
      'Set atomically by the redeem route (`updateMany({ where: { codeHash, redeemedAt: null } })` claim) on a single user request; the unique is a defense-in-depth backstop against double-redeem to the same workspace.',
  },
  {
    key: 'LicenseKey.redeemedGrantId',
    category: 'request_scoped',
    reason:
      'Stamped on the redeeming key immediately after `WorkspaceGrant.create` inside the same redeem request; one-to-one with the grant we just minted.',
  },
]

// ===========================================================================
// Schema parser — just enough to enumerate model fields and @unique markers.
// ===========================================================================

interface SchemaUnique {
  /** Canonical `<Model>.<col>` or `<Model>.(col1,col2,…)` key. */
  key: string
  model: string
  /** Columns participating in the unique. Sorted alpha. */
  columns: string[]
}

interface SchemaModel {
  name: string
  /** Field name -> raw type string. */
  fields: Map<string, string>
  uniques: SchemaUnique[]
}

function parseSchema(path: string): Map<string, SchemaModel> {
  const src = readFileSync(path, 'utf-8')
  const lines = src.split('\n')
  const models = new Map<string, SchemaModel>()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const modelMatch = /^\s*model\s+(\w+)\s*\{/.exec(line)
    if (!modelMatch) {
      i++
      continue
    }
    const name = modelMatch[1]
    const fields = new Map<string, string>()
    const uniques: SchemaUnique[] = []
    i++
    while (i < lines.length && !/^\s*\}/.test(lines[i])) {
      // Strip comments before further inspection so a `// ... @unique ...`
      // comment doesn't false-match.
      const raw = lines[i]
      const trimmed = raw.replace(/\/\/.*$/, '').trim()
      i++
      if (!trimmed) continue

      // @@unique([a, b, c])
      const blockMatch = /^@@unique\s*\(\s*\[\s*([^\]]+)\s*\]\s*\)/.exec(
        trimmed,
      )
      if (blockMatch) {
        const cols = blockMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const sorted = [...cols].sort()
        const key =
          sorted.length === 1
            ? `${name}.${sorted[0]}`
            : `${name}.(${sorted.join(',')})`
        uniques.push({ key, model: name, columns: sorted })
        continue
      }

      // Skip other @@ block attributes.
      if (trimmed.startsWith('@@')) continue
      // Skip relation-only field lines / etc.

      // field def: `name  Type @attrs...`
      const fieldMatch = /^(\w+)\s+(\S+)(.*)$/.exec(trimmed)
      if (!fieldMatch) continue
      const fieldName = fieldMatch[1]
      const fieldType = fieldMatch[2]
      const rest = fieldMatch[3]
      fields.set(fieldName, fieldType)
      // @unique on the field itself
      if (/\B@unique\b/.test(rest)) {
        const sorted = [fieldName]
        uniques.push({
          key: `${name}.${sorted[0]}`,
          model: name,
          columns: sorted,
        })
      }
    }
    models.set(name, { name, fields, uniques })
  }
  return models
}

// Map model name -> db table name. Falls back to the model name if no @@map.
function buildModelToTable(path: string): Map<string, string> {
  const src = readFileSync(path, 'utf-8')
  const mapping = new Map<string, string>()
  const modelRe = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm
  let m: RegExpExecArray | null
  while ((m = modelRe.exec(src))) {
    const name = m[1]
    const body = m[2]
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)
    mapping.set(name, mapMatch ? mapMatch[1] : name)
  }
  return mapping
}

// ===========================================================================
// AST walkers
// ===========================================================================

function loadSourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

interface CronEntry {
  /** Exported function name (e.g. `runGrantMonthlyRefill`). */
  fn: string
  /** Repo-relative file path. */
  file: string
  /** Line number (1-based) of the function declaration, for error msgs. */
  line: number
  node: ts.FunctionDeclaration | ts.VariableDeclaration
}

/**
 * Enumerate every exported async function declared in
 * `apps/api/src/jobs/*.ts` whose name starts with `run` followed by
 * an upper-case letter (the project's cron-entrypoint convention) and
 * the two storage/analytics functions explicitly invoked from
 * `server.ts`'s cron startup blocks.
 */
function enumerateCronEntries(): CronEntry[] {
  const entries: CronEntry[] = []

  // Jobs directory: every `export async function run<Foo>(...)`.
  const jobFiles = walkDir(JOBS_DIR).filter(
    (f) => f.endsWith('.ts') && !f.includes('__tests__'),
  )
  for (const file of jobFiles) {
    const sf = loadSourceFile(file)
    ts.forEachChild(sf, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        /^run[A-Z]/.test(node.name.text)
      ) {
        entries.push({
          fn: node.name.text,
          // Normalise to forward slashes so the equality check against
          // the INTENTIONALLY_REGIONAL allowlist (which is hand-written
          // with POSIX paths) passes on Windows, where `relative()`
          // emits `apps\api\...` and would otherwise compare unequal
          // to `apps/api/...`.
          file: relative(REPO_ROOT, file).replace(/\\/g, '/'),
          line:
            sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          node,
        })
      }
    })
  }

  // Two additional cron bodies invoked directly from server.ts's
  // setInterval startup (not in the jobs/ directory). These are wired
  // into the registry by hand because they don't match the run<Foo>
  // convention.
  const extras: Array<{ fn: string; file: string }> = [
    { fn: 'recalculateAllStorageUsage', file: STORAGE_SERVICE_PATH },
    { fn: 'generateDigest', file: ANALYTICS_DIGEST_PATH },
  ]
  for (const extra of extras) {
    if (!existsSync(extra.file)) continue
    const sf = loadSourceFile(extra.file)
    ts.forEachChild(sf, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === extra.fn &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        entries.push({
          fn: extra.fn,
          file: relative(REPO_ROOT, extra.file).replace(/\\/g, '/'),
          line:
            sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          node,
        })
      }
    })
  }

  return entries
}

function walkDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkDir(full))
    else out.push(full)
  }
  return out
}

/**
 * Return the literal argument passed to `withGlobalJobLock(<lit>, ...)`
 * anywhere inside `node`, or null if no such call is found.
 *
 * The plan requires the call to be the outermost await-target — i.e.
 * the function body's top-level statements should contain (in order):
 *   const r = await withGlobalJobLock('name', async () => {...})
 *   ...handle r.acquired branch...
 * We enforce that by walking only the top-level statements of the
 * function block, not arbitrarily nested expressions. This rejects
 * the failure mode where someone wraps `withGlobalJobLock` inside a
 * conditional / try/catch / loop and silently bypasses it.
 */
function findOutermostLockCall(
  fnNode: ts.FunctionDeclaration | ts.VariableDeclaration,
): string | null {
  let body: ts.Block | undefined
  if (ts.isFunctionDeclaration(fnNode)) body = fnNode.body
  else if (
    ts.isVariableDeclaration(fnNode) &&
    fnNode.initializer &&
    (ts.isArrowFunction(fnNode.initializer) ||
      ts.isFunctionExpression(fnNode.initializer))
  ) {
    const init = fnNode.initializer
    if (ts.isBlock(init.body)) body = init.body
  }
  if (!body) return null

  // Allow top-level let/const = await withGlobalJobLock(...) OR
  // bare await withGlobalJobLock(...).
  for (const stmt of body.statements) {
    const call = extractAwaitedLockCall(stmt)
    if (call) return call
  }
  return null
}

function extractAwaitedLockCall(stmt: ts.Statement): string | null {
  // `const x = await withGlobalJobLock('foo', async () => {...})`
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue
      const inner = unwrapAwait(decl.initializer)
      const arg = matchLockCall(inner)
      if (arg) return arg
    }
    return null
  }
  // `await withGlobalJobLock('foo', async () => {...})`
  if (ts.isExpressionStatement(stmt)) {
    const inner = unwrapAwait(stmt.expression)
    return matchLockCall(inner)
  }
  // `return await withGlobalJobLock(...)`
  if (ts.isReturnStatement(stmt) && stmt.expression) {
    const inner = unwrapAwait(stmt.expression)
    return matchLockCall(inner)
  }
  return null
}

function unwrapAwait(expr: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expr) ? expr.expression : expr
}

function matchLockCall(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  let name: string | null = null
  if (ts.isIdentifier(callee)) name = callee.text
  if (name !== 'withGlobalJobLock') return null
  const firstArg = expr.arguments[0]
  if (firstArg && ts.isStringLiteral(firstArg)) return firstArg.text
  return null
}

// ===========================================================================
// `KNOWN_JOB_IDS` extractor — parse the lock helper file for the
// registered job names so the guard's "wrapped" claim is cross-checked
// against the helper itself.
// ===========================================================================

function readKnownJobIds(): Set<string> {
  if (!existsSync(GLOBAL_JOB_LOCK_PATH)) return new Set()
  const sf = loadSourceFile(GLOBAL_JOB_LOCK_PATH)
  const found = new Set<string>()
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'KNOWN_JOB_IDS' &&
      node.initializer
    ) {
      // Object literal — possibly wrapped in `Object.freeze({...}) as ...`.
      let init: ts.Expression = node.initializer
      if (ts.isAsExpression(init)) init = init.expression
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        init.expression.name.text === 'freeze'
      ) {
        init = init.arguments[0]
      }
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isStringLiteral(prop.name)
          ) {
            found.add(prop.name.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

// ===========================================================================
// Checks
// ===========================================================================

interface Violation {
  where: string
  message: string
}

function checkCronWrappers(
  entries: CronEntry[],
  knownJobIds: Set<string>,
): Violation[] {
  const violations: Violation[] = []
  const regionalIndex = new Map<string, IntentionallyRegional>()
  for (const r of INTENTIONALLY_REGIONAL) regionalIndex.set(r.fn, r)

  for (const entry of entries) {
    const exempt = regionalIndex.get(entry.fn)
    if (exempt) {
      if (exempt.file !== entry.file) {
        violations.push({
          where: `${entry.file}:${entry.line}`,
          message: `INTENTIONALLY_REGIONAL entry for \`${entry.fn}\` claims file \`${exempt.file}\` but found in \`${entry.file}\`. Fix the allowlist or move the function.`,
        })
      }
      continue
    }

    const lockArg = findOutermostLockCall(entry.node)
    if (lockArg === null) {
      violations.push({
        where: `${entry.file}:${entry.line}`,
        message:
          `Cron \`${entry.fn}\` is not wrapped in \`withGlobalJobLock(...)\` at the outermost statement of its body.\n` +
          `       Either wrap it (\`await withGlobalJobLock('<job-name>', async () => { ... })\` and register the name in KNOWN_JOB_IDS in apps/api/src/lib/global-job-lock.ts), ` +
          `or add it to INTENTIONALLY_REGIONAL in scripts/check-multiregion-cron-locks.ts with a regionKeyColumn justification.\n` +
          `       See the file header for the rationale and the 2026-05-21 analytics_digests incident.`,
      })
      continue
    }
    if (!knownJobIds.has(lockArg)) {
      violations.push({
        where: `${entry.file}:${entry.line}`,
        message: `Cron \`${entry.fn}\` calls \`withGlobalJobLock('${lockArg}', ...)\` but '${lockArg}' is not in KNOWN_JOB_IDS in apps/api/src/lib/global-job-lock.ts. Add it there so the CI registry stays in sync.`,
      })
    }
  }

  // Reverse direction: every INTENTIONALLY_REGIONAL entry must
  // actually reference a real cron in `entries` (no stale allowlist).
  const entryNames = new Set(entries.map((e) => e.fn))
  for (const r of INTENTIONALLY_REGIONAL) {
    if (!entryNames.has(r.fn)) {
      violations.push({
        where: r.file,
        message: `INTENTIONALLY_REGIONAL entry \`${r.fn}\` does not match any discovered cron entry. Either remove the allowlist entry or restore the cron.`,
      })
    }
  }

  return violations
}

function checkIntentionallyRegionalSchema(
  models: Map<string, SchemaModel>,
  modelToTable: Map<string, string>,
): Violation[] {
  const violations: Violation[] = []
  const tableToModel = new Map<string, string>()
  for (const [model, table] of modelToTable) tableToModel.set(table, model)

  for (const r of INTENTIONALLY_REGIONAL) {
    const [table, col] = r.regionKeyColumn.split('.')
    if (!table || !col) {
      violations.push({
        where: r.file,
        message: `INTENTIONALLY_REGIONAL.\`${r.fn}\`.regionKeyColumn=\`${r.regionKeyColumn}\` must be in \`<table>.<column>\` form.`,
      })
      continue
    }
    const modelName = tableToModel.get(table) ?? table
    const model = models.get(modelName)
    if (!model) {
      violations.push({
        where: r.file,
        message: `INTENTIONALLY_REGIONAL.\`${r.fn}\`.regionKeyColumn=\`${r.regionKeyColumn}\` references unknown model/table.`,
      })
      continue
    }
    if (!model.fields.has(col)) {
      violations.push({
        where: r.file,
        message: `INTENTIONALLY_REGIONAL.\`${r.fn}\`.regionKeyColumn=\`${r.regionKeyColumn}\`: column \`${col}\` is not declared on \`${modelName}\`.`,
      })
      continue
    }
    const partOfUnique = model.uniques.some((u) => u.columns.includes(col))
    if (!partOfUnique) {
      violations.push({
        where: r.file,
        message: `INTENTIONALLY_REGIONAL.\`${r.fn}\`.regionKeyColumn=\`${r.regionKeyColumn}\`: column \`${col}\` is declared on \`${modelName}\` but is NOT part of any @unique / @@unique on that model. Without that, "intentionally regional" is a lie — every region's write will still collide on whatever unique IS on the model.`,
      })
    }
  }
  return violations
}

function checkUniqueRegistry(
  models: Map<string, SchemaModel>,
  knownJobIds: Set<string>,
): Violation[] {
  const violations: Violation[] = []
  const allowedByKey = new Map<string, UniqueKeyRule>()
  for (const rule of ACCEPTED_UNIQUE_KEYS) allowedByKey.set(rule.key, rule)

  const schemaUniqueKeys = new Set<string>()
  for (const model of models.values()) {
    for (const u of model.uniques) schemaUniqueKeys.add(u.key)
  }

  // Direction 1: every schema unique must be classified.
  for (const key of schemaUniqueKeys) {
    const rule = allowedByKey.get(key)
    if (!rule) {
      violations.push({
        where: 'prisma/schema.prisma',
        message:
          `Unique constraint \`${key}\` is not classified in ACCEPTED_UNIQUE_KEYS in scripts/check-multiregion-cron-locks.ts.\n` +
          `       Add an entry with one of: random_secret | external_global_id | request_scoped | single_tenant_upsert | cron_locked | cron_regional, plus a one-line justification.\n` +
          `       This is the structural guard that would have caught the storage_usage poison-pill at PR time.`,
      })
      continue
    }
    if (rule.category === 'cron_locked') {
      if (!rule.writer) {
        violations.push({
          where: 'scripts/check-multiregion-cron-locks.ts',
          message: `ACCEPTED_UNIQUE_KEYS.\`${key}\` is category=cron_locked but missing a \`writer\` field referencing a KNOWN_JOB_IDS entry.`,
        })
      } else if (!knownJobIds.has(rule.writer)) {
        violations.push({
          where: 'scripts/check-multiregion-cron-locks.ts',
          message: `ACCEPTED_UNIQUE_KEYS.\`${key}\`.writer=\`${rule.writer}\` is not in KNOWN_JOB_IDS in apps/api/src/lib/global-job-lock.ts. The classification claims a cron-lock writer that doesn't exist.`,
        })
      }
    }
    if (rule.category === 'cron_regional') {
      if (!rule.writer) {
        violations.push({
          where: 'scripts/check-multiregion-cron-locks.ts',
          message: `ACCEPTED_UNIQUE_KEYS.\`${key}\` is category=cron_regional but missing a \`writer\` field referencing an INTENTIONALLY_REGIONAL entry.`,
        })
      } else {
        const regional = INTENTIONALLY_REGIONAL.find(
          (r) => r.fn === rule.writer,
        )
        if (!regional) {
          violations.push({
            where: 'scripts/check-multiregion-cron-locks.ts',
            message: `ACCEPTED_UNIQUE_KEYS.\`${key}\`.writer=\`${rule.writer}\` does not match any INTENTIONALLY_REGIONAL.fn entry.`,
          })
        }
      }
    }
  }

  // Direction 2: no stale allowlist entries (catches schema column
  // renames that orphan an ACCEPTED_UNIQUE_KEYS entry).
  for (const rule of ACCEPTED_UNIQUE_KEYS) {
    if (!schemaUniqueKeys.has(rule.key)) {
      violations.push({
        where: 'scripts/check-multiregion-cron-locks.ts',
        message: `ACCEPTED_UNIQUE_KEYS.\`${rule.key}\` does not match any @unique / @@unique in prisma/schema.prisma. Remove the stale allowlist entry.`,
      })
    }
  }

  return violations
}

// ===========================================================================
// Entry point
// ===========================================================================

function main(argv: string[]): number {
  const quiet = argv.includes('--quiet')

  if (!existsSync(SCHEMA_PATH)) {
    console.error(`[check-multiregion-cron-locks] schema not found at ${SCHEMA_PATH}`)
    return 2
  }
  if (!existsSync(GLOBAL_JOB_LOCK_PATH)) {
    console.error(
      `[check-multiregion-cron-locks] global-job-lock.ts not found at ${GLOBAL_JOB_LOCK_PATH}`,
    )
    return 2
  }
  if (!existsSync(SERVER_PATH)) {
    console.error(`[check-multiregion-cron-locks] server.ts not found at ${SERVER_PATH}`)
    return 2
  }

  const models = parseSchema(SCHEMA_PATH)
  const modelToTable = buildModelToTable(SCHEMA_PATH)
  const knownJobIds = readKnownJobIds()
  const cronEntries = enumerateCronEntries()

  const violations: Violation[] = [
    ...checkIntentionallyRegionalSchema(models, modelToTable),
    ...checkCronWrappers(cronEntries, knownJobIds),
    ...checkUniqueRegistry(models, knownJobIds),
  ]

  if (violations.length === 0) {
    if (!quiet) {
      console.log(
        `[check-multiregion-cron-locks] OK — ${cronEntries.length} cron entries, ` +
          `${knownJobIds.size} wrapped, ${INTENTIONALLY_REGIONAL.length} intentionally regional, ` +
          `${ACCEPTED_UNIQUE_KEYS.length} classified unique constraints.`,
      )
    }
    return 0
  }

  console.error('[check-multiregion-cron-locks] FAIL')
  for (const v of violations) {
    console.error(`  ${v.where}: ${v.message}`)
  }
  console.error(
    '\nThis check exists because of the 2026-05-21 analytics_digests poison-pill\n' +
      'incident. Background and rationale live in:\n' +
      '  - prisma/migrations/20260521000000_add_region_to_analytics_digest/migration.sql\n' +
      '  - apps/api/src/lib/global-job-lock.ts (header)\n' +
      '  - this script (header).',
  )
  return 1
}

// Allow importing from tests without immediately running.
const isMain = typeof require !== 'undefined'
  ? require.main === module
  : import.meta.main === true

if (isMain) {
  process.exit(main(process.argv.slice(2)))
}

export {
  ACCEPTED_UNIQUE_KEYS,
  INTENTIONALLY_REGIONAL,
  parseSchema,
  buildModelToTable,
  enumerateCronEntries,
  findOutermostLockCall,
  readKnownJobIds,
  checkCronWrappers,
  checkIntentionallyRegionalSchema,
  checkUniqueRegistry,
  main,
}

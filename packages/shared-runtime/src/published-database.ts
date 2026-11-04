// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Postgres at publish (SHO-308 §1) — the pure half.
 *
 * Every published environment gets its own database on the `projects-pg`
 * cluster, its own role, and a `DATABASE_URL` that points at the PgBouncer
 * pooler rather than the primary (published apps are request workers: they open
 * a handful of connections each, so the pooler is what keeps a fleet of
 * replicas from exhausting the cluster's connection slots).
 *
 * Nothing here touches the network or K8s, so the naming rules, the URL
 * rewriting and the schema classification can be unit-tested and reused by the
 * publish route, the ops service and the cutover script.
 */

/**
 * The environments a published app can run in. Declared here (not imported from
 * apps/api) because both the API and the runtime need it.
 */
export type PublishedEnvironmentName = 'production' | 'staging'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Postgres identifiers are limited to 63 bytes. */
const MAX_IDENTIFIER = 63

/**
 * Database (and role) name for one environment.
 *
 * Production keeps the historical `project_<uuid>` name so a project's existing
 * database carries over; staging gets a `_staging` suffix rather than a separate
 * cluster, so both environments share one PgBouncer pooler and one backup job
 * while remaining separate databases with no cross-database access.
 */
export function publishedDbName(
  projectId: string,
  environment: PublishedEnvironmentName = 'production',
): string {
  if (!UUID_RE.test(projectId)) {
    throw new Error(
      `Invalid project ID format: expected UUID, got "${projectId.slice(0, 40)}"`,
    )
  }
  const base = `project_${projectId.replace(/-/g, '_')}`
  const name = environment === 'staging' ? `${base}_staging` : base
  if (name.length > MAX_IDENTIFIER) {
    // Cannot happen with a UUID, but a silent truncation would collide two
    // projects onto one database, so fail loudly instead.
    throw new Error(`Database name "${name}" exceeds ${MAX_IDENTIFIER} characters`)
  }
  return name
}

/**
 * The K8s Secret that carries one environment's `DATABASE_URL`.
 *
 * The Knative ksvc mounts this key by name (see createPublishedServerService),
 * so this function is the single definition both sides reference.
 */
export function publishedDbSecretName(
  projectId: string,
  environment: PublishedEnvironmentName = 'production',
): string {
  return `published-db-${projectId}-${environment}`
}

/** Connection parameters a published app's Prisma client needs behind PgBouncer. */
export const PUBLISHED_DB_CONNECTION_LIMIT = '5'

/**
 * Rewrite a direct `postgres://` URL into the pooled one a published pod uses.
 *
 * Prisma needs `pgbouncer=true` to stop using prepared statements, which
 * transaction-mode pooling does not support, and a low `connection_limit`
 * because the pooler — not the app — owns the fan-out.
 */
export function toPublishedDatabaseUrl(
  directUrl: string,
  opts: { poolerHost?: string; connectionLimit?: string } = {},
): string {
  let url: URL
  try {
    url = new URL(directUrl)
  } catch {
    throw new Error('Cannot build a published database URL from an invalid URL')
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`Published databases must be Postgres, got "${url.protocol}"`)
  }
  if (opts.poolerHost) {
    url.hostname = opts.poolerHost
  }
  // PgBouncer's transaction mode is served on the same port as the primary in
  // the CNPG Pooler Service, so the port is carried over unchanged.
  url.searchParams.set('pgbouncer', 'true')
  url.searchParams.set('connection_limit', opts.connectionLimit ?? PUBLISHED_DB_CONNECTION_LIMIT)
  return url.toString()
}

/**
 * Sanity check used before a URL is written into a Secret and handed to a pod:
 * it must be a Postgres URL, it must be pooled, and it must not point at the
 * admin connection string.
 */
export function assertPublishedDatabaseUrl(url: string): void {
  const parsed = new URL(url)
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error('Published DATABASE_URL must be a Postgres URL')
  }
  if (parsed.searchParams.get('pgbouncer') !== 'true') {
    throw new Error('Published DATABASE_URL must set pgbouncer=true (it goes through the pooler)')
  }
}

// =============================================================================
// Schema change classification (AC 2)
//
// The provider swap itself is not reimplemented here: packages/db/src/schema-transformer.ts
// already owns SQLite↔Postgres translation (it is what the test suites use). This
// module only answers the question that file does not: what would this schema
// push destroy?
// =============================================================================

export interface SchemaField {
  name: string
  type: string
  optional: boolean
  list: boolean
  hasDefault: boolean
}

export interface ParsedSchema {
  models: Map<string, Map<string, SchemaField>>
  enums: Map<string, Set<string>>
}

/**
 * A deliberately small Prisma schema parser: models, scalar fields, enum values.
 * Enough to answer "would this deploy drop data?", which is the only question
 * the publish path asks before it runs a schema push against a live database.
 */
export function parseSchema(schema: string): ParsedSchema {
  const models = new Map<string, Map<string, SchemaField>>()
  const enums = new Map<string, Set<string>>()

  const blockRe = /(model|enum)\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(schema))) {
    const [, kind, name, body] = m
    if (kind === 'enum') {
      const values = new Set<string>()
      for (const raw of body.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('//') || line.startsWith('@@')) continue
        values.add(line.split(/\s+/)[0]!)
      }
      enums.set(name!, values)
      continue
    }
    const fields = new Map<string, SchemaField>()
    for (const raw of body.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue
      const fm = line.match(/^(\w+)\s+([A-Za-z_]\w*)(\[\])?(\?)?(.*)$/)
      if (!fm) continue
      const [, fieldName, fieldType, list, optional, rest] = fm
      fields.set(fieldName!, {
        name: fieldName!,
        type: fieldType!,
        optional: Boolean(optional),
        list: Boolean(list),
        hasDefault: /@default\s*\(/.test(rest ?? '') || /@updatedAt/.test(rest ?? ''),
      })
    }
    models.set(name!, fields)
  }
  return { models, enums }
}

export interface DestructiveChange {
  kind:
    | 'dropped_model'
    | 'dropped_field'
    | 'changed_type'
    | 'required_without_default'
    | 'removed_enum_value'
  name: string
  message: string
}

/**
 * What a schema push from `previous` to `next` would destroy.
 *
 * Prisma's own `db push` will drop a column when the field disappears, which
 * loses every row in it — so publish refuses unless the caller passed
 * `allow_data_loss`. Adding a required column with no default is equally
 * unrecoverable on a populated table (the push cannot invent values), so it is
 * reported the same way, with its own kind so the message can say "give it a
 * default" instead of "you are dropping data".
 */
export function classifySchemaChange(previous: string, next: string): DestructiveChange[] {
  const before = parseSchema(previous)
  const after = parseSchema(next)
  const out: DestructiveChange[] = []

  for (const [modelName, beforeFields] of before.models) {
    const afterFields = after.models.get(modelName)
    if (!afterFields) {
      out.push({
        kind: 'dropped_model',
        name: modelName,
        message: `model ${modelName} would be dropped, losing every row in it`,
      })
      continue
    }
    for (const [fieldName, beforeField] of beforeFields) {
      const afterField = afterFields.get(fieldName)
      const label = `${modelName}.${fieldName}`
      if (!afterField) {
        out.push({
          kind: 'dropped_field',
          name: label,
          message: `field ${label} would be dropped, losing every value in it`,
        })
        continue
      }
      if (afterField.type !== beforeField.type || afterField.list !== beforeField.list) {
        out.push({
          kind: 'changed_type',
          name: label,
          message: `field ${label} changes type (${beforeField.type} → ${afterField.type}), which rewrites or drops its values`,
        })
        continue
      }
      if (beforeField.optional && !afterField.optional && !afterField.hasDefault) {
        out.push({
          kind: 'required_without_default',
          name: label,
          message: `field ${label} becomes required with no @default, so existing rows have no value for it`,
        })
      }
    }
    for (const [fieldName, afterField] of afterFields) {
      if (beforeFields.has(fieldName)) continue
      if (!afterField.optional && !afterField.hasDefault && !afterField.list) {
        out.push({
          kind: 'required_without_default',
          name: `${modelName}.${fieldName}`,
          message: `new field ${modelName}.${fieldName} is required with no @default, so existing rows have no value for it`,
        })
      }
    }
  }

  for (const [enumName, beforeValues] of before.enums) {
    const afterValues = after.enums.get(enumName)
    if (!afterValues) continue // whole enum gone: covered by the fields that used it
    for (const value of beforeValues) {
      if (afterValues.has(value)) continue
      out.push({
        kind: 'removed_enum_value',
        name: `${enumName}.${value}`,
        message: `enum value ${enumName}.${value} would be removed, and rows still holding it become unreadable`,
      })
    }
  }

  return out
}

/** One-line summary for the API error and the agent's tool result. */
export function describeDestructiveChanges(changes: DestructiveChange[]): string {
  if (changes.length === 0) return ''
  const head = changes.slice(0, 3).map((c) => c.message)
  const more = changes.length > head.length ? ` (+${changes.length - head.length} more)` : ''
  return `${head.join('; ')}${more}. Republish with allow_data_loss to proceed.`
}

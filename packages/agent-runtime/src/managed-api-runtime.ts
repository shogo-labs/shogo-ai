/**
 * Managed API Runtime
 *
 * Manages the full lifecycle from model JSON definitions to a running Hono API
 * backed by SQLite. Uses Bun's built-in SQLite for zero-dependency database
 * support and builds Hono CRUD routes dynamically from model definitions.
 *
 * Each surface can have its own ManagedApiRuntime with an isolated SQLite DB.
 */

import { Hono } from 'hono'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'

type SqlParam = SQLQueryBindings

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldType = 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'Json'

export interface ModelField {
  name: string
  type: FieldType
  optional?: boolean
  default?: unknown
  unique?: boolean
}

export interface ModelDefinition {
  name: string
  fields: ModelField[]
}

export interface ManagedApiConfig {
  surfaceId: string
  /** Directory to store the SQLite database file */
  workDir: string
}

interface ModelEndpoint {
  model: string
  path: string
  methods: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPlural(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1)
  const kebab = lower.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (kebab.endsWith('y') && !kebab.endsWith('ay') && !kebab.endsWith('ey') && !kebab.endsWith('oy') && !kebab.endsWith('uy')) {
    return kebab.slice(0, -1) + 'ies'
  }
  if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) {
    return kebab + 'es'
  }
  return kebab + 's'
}

function fieldTypeToSql(type: FieldType): string {
  switch (type) {
    case 'String': return 'TEXT'
    case 'Int': return 'INTEGER'
    case 'Float': return 'REAL'
    case 'Boolean': return 'INTEGER'
    case 'DateTime': return 'TEXT'
    case 'Json': return 'TEXT'
  }
}

function sqlDefault(field: ModelField): string {
  if (field.default === undefined || field.default === null) return ''
  if (field.type === 'Boolean') return ` DEFAULT ${field.default ? 1 : 0}`
  if (field.type === 'String' || field.type === 'DateTime') return ` DEFAULT '${field.default}'`
  if (field.type === 'Json') return ` DEFAULT '${JSON.stringify(field.default)}'`
  return ` DEFAULT ${field.default}`
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 25; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

function coerceDefaultValue(field: ModelField): unknown {
  if (field.default === undefined || field.default === null) return null
  if (field.type === 'Boolean') return field.default ? 1 : 0
  if (field.type === 'Json' && typeof field.default !== 'string') return JSON.stringify(field.default)
  return field.default
}

function coerceRow(row: Record<string, unknown>, fields: ModelField[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...row }
  for (const field of fields) {
    const val = result[field.name]
    if (val === undefined || val === null) continue
    if (field.type === 'Boolean') {
      result[field.name] = val === 1 || val === true || val === 'true'
    } else if (field.type === 'Json' && typeof val === 'string') {
      try { result[field.name] = JSON.parse(val) } catch { /* keep as string */ }
    }
  }
  return result
}

function coerceForInsert(data: Record<string, unknown>, fields: ModelField[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const fieldMap = new Map(fields.map(f => [f.name, f]))

  for (const [key, val] of Object.entries(data)) {
    if (key === 'id' || key === 'createdAt' || key === 'updatedAt') {
      result[key] = val
      continue
    }
    const field = fieldMap.get(key)
    if (!field) continue
    if (val === undefined || val === null) {
      result[key] = null
      continue
    }
    if (field.type === 'Boolean') {
      result[key] = val === true || val === 'true' || val === 1 ? 1 : 0
    } else if (field.type === 'Json' && typeof val !== 'string') {
      result[key] = JSON.stringify(val)
    } else {
      result[key] = val
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// ManagedApiRuntime
// ---------------------------------------------------------------------------

export class ManagedApiRuntime {
  private app: Hono
  private db: Database
  private models: ModelDefinition[] = []
  private modelMap = new Map<string, ModelDefinition>()
  private endpoints: ModelEndpoint[] = []
  private _ready = false
  private config: ManagedApiConfig
  private dbPath: string

  constructor(config: ManagedApiConfig) {
    this.config = config

    mkdirSync(config.workDir, { recursive: true })
    this.dbPath = join(config.workDir, `${config.surfaceId}.db`)
    this.db = new Database(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')

    this.app = new Hono()
  }

  // ---------------------------------------------------------------------------
  // Schema Management
  // ---------------------------------------------------------------------------

  applySchema(models: ModelDefinition[], reset = false): { ok: boolean; endpoints: ModelEndpoint[]; models: string[]; error?: string } {
    try {
      if (reset) {
        for (const model of this.models) {
          this.db.exec(`DROP TABLE IF EXISTS "${model.name}"`)
        }
      }

      for (const model of models) {
        this.createTable(model)
        this.modelMap.set(model.name, model)
        this.modelMap.set(model.name.toLowerCase(), model)
      }

      this.models = models
      this.endpoints = []
      this.app = this.buildRoutes()
      this._ready = true

      return {
        ok: true,
        endpoints: this.endpoints,
        models: models.map(m => m.name),
      }
    } catch (err: any) {
      return { ok: false, endpoints: [], models: [], error: err.message }
    }
  }

  private createTable(model: ModelDefinition): void {
    const columns: string[] = [
      '"id" TEXT PRIMARY KEY',
      '"createdAt" TEXT NOT NULL',
      '"updatedAt" TEXT NOT NULL',
    ]

    for (const field of model.fields) {
      let col = `"${field.name}" ${fieldTypeToSql(field.type)}`
      if (!field.optional) col += ' NOT NULL'
      col += sqlDefault(field)
      if (field.unique) col += ' UNIQUE'
      columns.push(col)
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS "${model.name}" (${columns.join(', ')})`)
  }

  // ---------------------------------------------------------------------------
  // Data Operations
  // ---------------------------------------------------------------------------

  seed(modelName: string, records: Record<string, unknown>[], upsert = false): { ok: boolean; model: string; inserted: number; total: number; error?: string } {
    const model = this.modelMap.get(modelName) || this.modelMap.get(modelName.toLowerCase())
    if (!model) {
      return { ok: false, model: modelName, inserted: 0, total: 0, error: `Model "${modelName}" not found` }
    }

    const now = new Date().toISOString()
    let inserted = 0

    const allFieldNames = ['id', 'createdAt', 'updatedAt', ...model.fields.map(f => f.name)]
    const cols = allFieldNames.map(n => `"${n}"`).join(', ')
    const placeholders = allFieldNames.map(() => '?').join(', ')

    const insertSql = `INSERT INTO "${model.name}" (${cols}) VALUES (${placeholders})`
    const upsertUpdateSet = model.fields.map(f => `"${f.name}" = excluded."${f.name}"`).join(', ')
    const upsertSql = `INSERT INTO "${model.name}" (${cols}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${upsertUpdateSet}, "updatedAt" = excluded."updatedAt"`

    this.db.exec('BEGIN TRANSACTION')
    try {
      const stmt = this.db.prepare(upsert ? upsertSql : insertSql)

      for (const record of records) {
        const data = coerceForInsert(record, model.fields)
        const id = (data.id as string) || generateId()
        const createdAt = (data.createdAt as string) || now
        const updatedAt = (data.updatedAt as string) || now

        const params: SqlParam[] = [id, createdAt, updatedAt]
        for (const field of model.fields) {
          let val = data[field.name]
          if (val === undefined || val === null) {
            val = field.default !== undefined ? coerceDefaultValue(field) : null
          }
          params.push(val as SqlParam)
        }

        stmt.run(...params)
        inserted++
      }
      this.db.exec('COMMIT')
    } catch (err: any) {
      this.db.exec('ROLLBACK')
      return { ok: false, model: modelName, inserted, total: 0, error: err.message }
    }

    const countResult = this.db.prepare(`SELECT COUNT(*) as count FROM "${model.name}"`).get() as any
    return { ok: true, model: modelName, inserted, total: countResult?.count ?? 0 }
  }

  query(
    modelName: string,
    params?: { where?: Record<string, unknown>; orderBy?: string; limit?: number; offset?: number },
  ): { ok: boolean; items: Record<string, unknown>[]; count: number; error?: string } {
    const model = this.modelMap.get(modelName) || this.modelMap.get(modelName.toLowerCase())
    if (!model) {
      return { ok: false, items: [], count: 0, error: `Model "${modelName}" not found` }
    }

    const { sql, values } = this.buildSelectQuery(model, params)
    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[]
    const items = rows.map(row => coerceRow(row, model.fields))
    return { ok: true, items, count: items.length }
  }

  private buildSelectQuery(
    model: ModelDefinition,
    params?: { where?: Record<string, unknown>; orderBy?: string; limit?: number; offset?: number },
  ): { sql: string; values: SqlParam[] } {
    let sql = `SELECT * FROM "${model.name}"`
    const values: SqlParam[] = []
    const conditions: string[] = []

    if (params?.where) {
      for (const [key, val] of Object.entries(params.where)) {
        if (val === undefined || val === null) continue
        conditions.push(`"${key}" = ?`)
        values.push(val as SqlParam)
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    if (params?.orderBy) {
      const desc = params.orderBy.startsWith('-')
      const field = desc ? params.orderBy.slice(1) : params.orderBy
      sql += ` ORDER BY "${field}" ${desc ? 'DESC' : 'ASC'}`
    } else {
      sql += ' ORDER BY "createdAt" DESC'
    }

    if (params?.limit) {
      sql += ` LIMIT ${params.limit}`
    }
    if (params?.offset) {
      sql += ` OFFSET ${params.offset}`
    }

    return { sql, values }
  }

  // ---------------------------------------------------------------------------
  // Hono Route Builder
  // ---------------------------------------------------------------------------

  private buildRoutes(): Hono {
    const app = new Hono()

    app.get('/api/_models', (c) => {
      return c.json({
        ok: true,
        models: this.models.map(m => ({
          name: m.name,
          endpoint: `/api/${toPlural(m.name)}`,
          fields: m.fields.map(f => ({ name: f.name, type: f.type, optional: !!f.optional })),
        })),
      })
    })

    for (const model of this.models) {
      const plural = toPlural(model.name)
      const basePath = `/api/${plural}`

      this.endpoints.push({
        model: model.name,
        path: basePath,
        methods: ['GET', 'POST', 'GET /:id', 'PATCH /:id', 'DELETE /:id'],
      })

      // LIST
      app.get(basePath, (c) => {
        try {
          const url = new URL(c.req.url)
          const where: Record<string, unknown> = {}
          const reserved = new Set(['limit', 'offset', 'orderBy'])
          const boolFields = new Set(model.fields.filter(f => f.type === 'Boolean').map(f => f.name))

          for (const [key, value] of url.searchParams) {
            if (reserved.has(key)) continue
            if (boolFields.has(key)) {
              where[key] = value === 'true' || value === '1' ? 1 : 0
            } else {
              where[key] = value
            }
          }

          const result = this.query(model.name, {
            where: Object.keys(where).length > 0 ? where : undefined,
            orderBy: url.searchParams.get('orderBy') || undefined,
            limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!) : undefined,
            offset: url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!) : undefined,
          })
          return c.json(result)
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })

      // GET by ID
      app.get(`${basePath}/:id`, (c) => {
        try {
          const id = c.req.param('id')
          const row = this.db.prepare(`SELECT * FROM "${model.name}" WHERE id = ?`).get(id) as Record<string, unknown> | null
          if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
          return c.json({ ok: true, item: coerceRow(row, model.fields) })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })

      // CREATE
      app.post(basePath, async (c) => {
        try {
          const body = await c.req.json()
          const data = coerceForInsert(body, model.fields)
          const id = (data.id as string) || generateId()
          const now = new Date().toISOString()

          const allFieldNames = ['id', 'createdAt', 'updatedAt', ...model.fields.map(f => f.name)]
          const params: SqlParam[] = [id, now, now]
          for (const field of model.fields) {
            let val = data[field.name]
            if (val === undefined || val === null) {
              val = field.default !== undefined ? coerceDefaultValue(field) : null
            }
            params.push(val as SqlParam)
          }

          const cols = allFieldNames.map(n => `"${n}"`).join(', ')
          const placeholders = allFieldNames.map(() => '?').join(', ')
          this.db.prepare(`INSERT INTO "${model.name}" (${cols}) VALUES (${placeholders})`).run(...params)

          const item = this.db.prepare(`SELECT * FROM "${model.name}" WHERE id = ?`).get(id) as Record<string, unknown>
          return c.json({ ok: true, item: coerceRow(item, model.fields) }, 201)
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 400)
        }
      })

      // UPDATE
      app.patch(`${basePath}/:id`, async (c) => {
        try {
          const id = c.req.param('id')
          const body = await c.req.json()
          const data = coerceForInsert(body, model.fields)
          const now = new Date().toISOString()

          const setClauses: string[] = []
          const params: SqlParam[] = []

          for (const [key, val] of Object.entries(data)) {
            if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue
            setClauses.push(`"${key}" = ?`)
            params.push(val as SqlParam)
          }
          setClauses.push('"updatedAt" = ?')
          params.push(now)
          params.push(id)

          this.db.prepare(`UPDATE "${model.name}" SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

          const item = this.db.prepare(`SELECT * FROM "${model.name}" WHERE id = ?`).get(id) as Record<string, unknown> | null
          if (!item) return c.json({ ok: false, error: 'Not found' }, 404)
          return c.json({ ok: true, item: coerceRow(item, model.fields) })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 400)
        }
      })

      // DELETE
      app.delete(`${basePath}/:id`, (c) => {
        try {
          const id = c.req.param('id')
          const existing = this.db.prepare(`SELECT id FROM "${model.name}" WHERE id = ?`).get(id)
          if (!existing) return c.json({ ok: false, error: 'Not found' }, 404)
          this.db.prepare(`DELETE FROM "${model.name}" WHERE id = ?`).run(id)
          return c.json({ ok: true })
        } catch (err: any) {
          return c.json({ ok: false, error: err.message }, 500)
        }
      })
    }

    return app
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getApp(): Hono { return this.app }
  getModels(): ModelDefinition[] { return this.models }
  getEndpoints(): ModelEndpoint[] { return this.endpoints }
  isReady(): boolean { return this._ready }
  getDbPath(): string { return this.dbPath }

  getModelEndpointInfo(): Array<{ name: string; endpoint: string; fields: string[] }> {
    return this.models.map(m => ({
      name: m.name,
      endpoint: `/api/${toPlural(m.name)}`,
      fields: ['id', 'createdAt', 'updatedAt', ...m.fields.map(f => f.name)],
    }))
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    try {
      this.db.close()
    } catch { /* already closed */ }
    this._ready = false
  }
}

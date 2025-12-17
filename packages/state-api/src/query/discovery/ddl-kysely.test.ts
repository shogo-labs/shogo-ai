/**
 * DDL Generation PoC: Kysely
 *
 * RESEARCH SUMMARY
 * ================
 *
 * What Kysely Offers for DDL Generation:
 * ---------------------------------------
 * Kysely provides a programmatic schema builder via `db.schema.createTable()` with a fluent API
 * for defining tables, columns, constraints, and indexes. It works WITHOUT static TypeScript types
 * by using `Kysely<any>`, making it suitable for runtime schema generation from JSON Schema.
 *
 * Key Features:
 * - Fluent API: `.createTable()`, `.addColumn()`, `.addPrimaryKey()`, `.addForeignKeyConstraint()`
 * - Column modifiers: `.primaryKey()`, `.notNull()`, `.unique()`, `.defaultTo()`, `.references()`
 * - Foreign keys: Both column-level `.references('table.id')` and table-level `.addForeignKeyConstraint()`
 * - PostgreSQL types: Supports standard types (varchar, integer, uuid, timestamp, etc.) as strings
 * - Migrations: Built-in `Migrator` class with `FileMigrationProvider` for managing schema evolution
 * - Database agnostic: Supports PostgreSQL, MySQL, SQLite via dialect system
 *
 * Code Complexity Assessment:
 * ---------------------------
 * LOW-MEDIUM complexity. The fluent API is straightforward and maps well to JSON Schema structures.
 *
 * Example mapping:
 * - JSON Schema `type: 'string'` → `.addColumn('name', 'varchar')`
 * - JSON Schema `required` → `.notNull()`
 * - JSON Schema `x-mst-type: 'identifier'` → `.primaryKey()`
 * - JSON Schema `x-reference-type: 'single'` → `.addForeignKeyConstraint()`
 * - JSON Schema `format: 'uuid'` → `.addColumn('id', 'uuid')`
 * - JSON Schema `format: 'date-time'` → `.addColumn('createdAt', 'timestamp')`
 *
 * The challenge is NOT in using Kysely's API (which is simple), but in:
 * 1. Mapping JSON Schema types/formats to PostgreSQL column types
 * 2. Handling MST references (x-reference-type, x-reference-target)
 * 3. Building the column modifier chain programmatically
 * 4. Topological sorting for foreign key dependencies
 *
 * Pros:
 * -----
 * + Clean, fluent API that's easy to construct programmatically
 * + Works without static TypeScript types (uses `Kysely<any>`)
 * + Supports all major SQL databases (not just PostgreSQL)
 * + Built-in migration system (Migrator + FileMigrationProvider)
 * + Foreign key support at both column and table level
 * + Strong ecosystem with type generation tools (kysely-codegen, kanel-kysely)
 * + Can generate raw SQL via `.compile()` without executing (good for testing)
 * + Active maintenance and TypeScript-first design
 *
 * Cons:
 * -----
 * - Requires Kysely dependency (not installed, adds ~50KB)
 * - Requires database driver (pg, mysql2, better-sqlite3) for execution
 * - Type mapping from JSON Schema to SQL types is MANUAL (no built-in mapping)
 * - Self-references require careful ordering (parent column must exist)
 * - No built-in JSON Schema → DDL transformer (we'd need to build it)
 * - Some PostgreSQL-specific features require raw SQL (e.g., `sql\`gen_random_uuid()\``)
 * - Migrations are file-based by default (could be limiting for runtime generation)
 *
 * Recommendation:
 * ---------------
 * ADOPT with caution. Kysely is an EXCELLENT fit for programmatic DDL generation from JSON Schema.
 *
 * The API is clean, the library is well-maintained, and it works without static types. However,
 * we'll need to build:
 * 1. A robust JSON Schema type → PostgreSQL type mapper
 * 2. A reference dependency resolver (topological sort)
 * 3. A programmatic migration runner (not file-based)
 *
 * Alternative consideration: Generate raw SQL strings directly. Since we're generating DDL from
 * JSON Schema (not writing migrations by hand), the fluent API may be overkill. A simple template
 * approach with proper escaping might be lighter weight.
 *
 * If we need full query building (SELECT/INSERT/UPDATE), Kysely is a strong choice. If we ONLY
 * need DDL generation, raw SQL templates might suffice.
 *
 * References:
 * -----------
 * - Kysely Migrations: https://www.kysely.dev/docs/migrations
 * - Data Types: https://kysely.dev/docs/recipes/data-types
 * - Foreign Keys: https://kysely-org.github.io/kysely-apidoc/classes/CreateTableBuilder.html
 * - Getting Started: https://kysely.dev/docs/getting-started
 *
 * ============================================================================
 */

import { describe, test, expect } from 'bun:test'

// ============================================================================
// TEST SCHEMA (Enhanced JSON Schema)
// ============================================================================

const testSchema = {
  definitions: {
    Organization: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'name'],
    },
    Team: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        organizationId: {
          type: 'string',
          'x-reference-type': 'single',
          'x-reference-target': 'Organization',
        },
        parentId: {
          type: 'string',
          'x-reference-type': 'single',
          'x-reference-target': 'Team', // Self-reference
        },
      },
      required: ['id', 'name', 'organizationId'],
    },
  },
}

// ============================================================================
// TYPE MAPPING (JSON Schema → PostgreSQL)
// ============================================================================

/**
 * Maps JSON Schema type/format to PostgreSQL column type.
 * This is a simplified version - production would need to handle:
 * - minLength/maxLength → varchar(N)
 * - minimum/maximum → smallint/bigint
 * - enum → CHECK constraint or ENUM type
 * - arrays → ARRAY types
 * - nested objects → JSONB
 */
function mapJsonSchemaTypeToPostgres(property: any): string {
  const { type, format } = property

  // UUID format
  if (format === 'uuid') {
    return 'uuid'
  }

  // Date/time formats
  if (format === 'date-time' || format === 'timestamp') {
    return 'timestamptz'
  }
  if (format === 'date') {
    return 'date'
  }
  if (format === 'time') {
    return 'time'
  }

  // Standard JSON Schema types
  if (type === 'string') {
    return 'varchar'
  }
  if (type === 'integer') {
    return 'integer'
  }
  if (type === 'number') {
    return 'numeric'
  }
  if (type === 'boolean') {
    return 'boolean'
  }

  // Fallback
  return 'text'
}

// ============================================================================
// DDL GENERATOR (without Kysely - shows what we'd need)
// ============================================================================

interface ColumnDef {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
  reference?: { table: string; column: string }
}

interface TableDef {
  name: string
  columns: ColumnDef[]
  foreignKeys: Array<{
    constraintName: string
    columns: string[]
    refTable: string
    refColumns: string[]
  }>
}

/**
 * Generates PostgreSQL DDL from Enhanced JSON Schema definition.
 */
function generateTableDDL(modelName: string, definition: any): TableDef {
  const columns: ColumnDef[] = []
  const foreignKeys: Array<{
    constraintName: string
    columns: string[]
    refTable: string
    refColumns: string[]
  }> = []

  for (const [propName, propSchema] of Object.entries(definition.properties)) {
    const prop = propSchema as any
    const isRequired = definition.required?.includes(propName) ?? false
    const isPrimaryKey = prop['x-mst-type'] === 'identifier'
    const isReference = prop['x-reference-type'] === 'single'

    // Column type
    const columnType = mapJsonSchemaTypeToPostgres(prop)

    columns.push({
      name: propName,
      type: columnType,
      notNull: isRequired,
      primaryKey: isPrimaryKey,
    })

    // Foreign key
    if (isReference) {
      const refTarget = prop['x-reference-target']
      foreignKeys.push({
        constraintName: `fk_${modelName}_${propName}`,
        columns: [propName],
        refTable: refTarget,
        refColumns: ['id'], // Assume 'id' is the target column
      })
    }
  }

  return {
    name: modelName,
    columns,
    foreignKeys,
  }
}

/**
 * Renders TableDef as PostgreSQL CREATE TABLE statement.
 */
function renderCreateTableSQL(tableDef: TableDef): string {
  const lines: string[] = []
  lines.push(`CREATE TABLE "${tableDef.name}" (`)

  // Columns
  const columnDefs = tableDef.columns.map((col) => {
    let def = `  "${col.name}" ${col.type}`
    if (col.primaryKey) {
      def += ' PRIMARY KEY'
    }
    if (col.notNull && !col.primaryKey) {
      def += ' NOT NULL'
    }
    return def
  })

  // Foreign keys
  const fkDefs = tableDef.foreignKeys.map((fk) => {
    const cols = fk.columns.map((c) => `"${c}"`).join(', ')
    const refCols = fk.refColumns.map((c) => `"${c}"`).join(', ')
    return `  CONSTRAINT "${fk.constraintName}" FOREIGN KEY (${cols}) REFERENCES "${fk.refTable}" (${refCols})`
  })

  lines.push([...columnDefs, ...fkDefs].join(',\n'))
  lines.push(');')

  return lines.join('\n')
}

// ============================================================================
// KYSELY-STYLE FLUENT API SIMULATION
// ============================================================================

/**
 * Simulates Kysely's fluent API for building CREATE TABLE DDL.
 * This shows what the code would look like WITH Kysely.
 */
class MockKyselyTableBuilder {
  private tableName: string
  private columns: Array<{ name: string; type: string; modifiers: string[] }> = []
  private foreignKeys: Array<{ name: string; sql: string }> = []

  constructor(tableName: string) {
    this.tableName = tableName
  }

  addColumn(name: string, type: string, build?: (col: MockColumnBuilder) => void) {
    const builder = new MockColumnBuilder()
    if (build) {
      build(builder)
    }
    this.columns.push({
      name,
      type,
      modifiers: builder.getModifiers(),
    })
    return this
  }

  addForeignKeyConstraint(
    name: string,
    columns: string[],
    refTable: string,
    refColumns: string[]
  ) {
    const cols = columns.map((c) => `"${c}"`).join(', ')
    const refs = refColumns.map((c) => `"${c}"`).join(', ')
    this.foreignKeys.push({
      name,
      sql: `CONSTRAINT "${name}" FOREIGN KEY (${cols}) REFERENCES "${refTable}" (${refs})`,
    })
    return this
  }

  compile(): string {
    const lines: string[] = []
    lines.push(`CREATE TABLE "${this.tableName}" (`)

    const columnDefs = this.columns.map((col) => {
      const mods = col.modifiers.length > 0 ? ' ' + col.modifiers.join(' ') : ''
      return `  "${col.name}" ${col.type}${mods}`
    })

    const fkDefs = this.foreignKeys.map((fk) => `  ${fk.sql}`)

    lines.push([...columnDefs, ...fkDefs].join(',\n'))
    lines.push(');')

    return lines.join('\n')
  }
}

class MockColumnBuilder {
  private modifiers: string[] = []

  primaryKey() {
    this.modifiers.push('PRIMARY KEY')
    return this
  }

  notNull() {
    this.modifiers.push('NOT NULL')
    return this
  }

  unique() {
    this.modifiers.push('UNIQUE')
    return this
  }

  defaultTo(value: string) {
    this.modifiers.push(`DEFAULT ${value}`)
    return this
  }

  references(ref: string) {
    const [table, column] = ref.split('.')
    this.modifiers.push(`REFERENCES "${table}" ("${column}")`)
    return this
  }

  getModifiers(): string[] {
    return this.modifiers
  }
}

/**
 * Programmatically builds CREATE TABLE using Kysely-style API from JSON Schema.
 */
function buildKyselyStyleDDL(modelName: string, definition: any): string {
  const builder = new MockKyselyTableBuilder(modelName)

  for (const [propName, propSchema] of Object.entries(definition.properties)) {
    const prop = propSchema as any
    const isRequired = definition.required?.includes(propName) ?? false
    const isPrimaryKey = prop['x-mst-type'] === 'identifier'
    const isReference = prop['x-reference-type'] === 'single'

    // Map type
    const columnType = mapJsonSchemaTypeToPostgres(prop)

    // Build column with modifiers
    builder.addColumn(propName, columnType, (col) => {
      if (isPrimaryKey) {
        col.primaryKey()
      }
      if (isRequired && !isPrimaryKey) {
        col.notNull()
      }
    })

    // Foreign key (if reference)
    if (isReference) {
      const refTarget = prop['x-reference-target']
      builder.addForeignKeyConstraint(
        `fk_${modelName}_${propName}`,
        [propName],
        refTarget,
        ['id']
      )
    }
  }

  return builder.compile()
}

// ============================================================================
// TESTS
// ============================================================================

describe('DDL Generation PoC: Kysely', () => {
  describe('Type Mapping', () => {
    test('maps uuid format to uuid type', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'string', format: 'uuid' })
      expect(type).toBe('uuid')
    })

    test('maps date-time format to timestamptz', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'string', format: 'date-time' })
      expect(type).toBe('timestamptz')
    })

    test('maps string to varchar', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'string' })
      expect(type).toBe('varchar')
    })

    test('maps integer to integer', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'integer' })
      expect(type).toBe('integer')
    })

    test('maps number to numeric', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'number' })
      expect(type).toBe('numeric')
    })

    test('maps boolean to boolean', () => {
      const type = mapJsonSchemaTypeToPostgres({ type: 'boolean' })
      expect(type).toBe('boolean')
    })
  })

  describe('Direct DDL Generation', () => {
    test('generates Organization table DDL', () => {
      const tableDef = generateTableDDL('Organization', testSchema.definitions.Organization)

      expect(tableDef.name).toBe('Organization')
      expect(tableDef.columns).toHaveLength(3)

      // Check id column
      const idCol = tableDef.columns.find((c) => c.name === 'id')
      expect(idCol).toBeDefined()
      expect(idCol?.type).toBe('uuid')
      expect(idCol?.primaryKey).toBe(true)
      expect(idCol?.notNull).toBe(true)

      // Check name column
      const nameCol = tableDef.columns.find((c) => c.name === 'name')
      expect(nameCol).toBeDefined()
      expect(nameCol?.type).toBe('varchar')
      expect(nameCol?.notNull).toBe(true)

      // Check createdAt column
      const createdAtCol = tableDef.columns.find((c) => c.name === 'createdAt')
      expect(createdAtCol).toBeDefined()
      expect(createdAtCol?.type).toBe('timestamptz')
      expect(createdAtCol?.notNull).toBe(false)

      // No foreign keys
      expect(tableDef.foreignKeys).toHaveLength(0)
    })

    test('generates Team table DDL with foreign keys', () => {
      const tableDef = generateTableDDL('Team', testSchema.definitions.Team)

      expect(tableDef.name).toBe('Team')
      expect(tableDef.columns).toHaveLength(4)

      // Check organizationId (foreign key)
      const orgIdCol = tableDef.columns.find((c) => c.name === 'organizationId')
      expect(orgIdCol).toBeDefined()
      expect(orgIdCol?.type).toBe('varchar') // Default for reference
      expect(orgIdCol?.notNull).toBe(true)

      // Check parentId (self-reference)
      const parentIdCol = tableDef.columns.find((c) => c.name === 'parentId')
      expect(parentIdCol).toBeDefined()
      expect(parentIdCol?.type).toBe('varchar')
      expect(parentIdCol?.notNull).toBe(false)

      // Foreign keys
      expect(tableDef.foreignKeys).toHaveLength(2)

      const orgFk = tableDef.foreignKeys.find((fk) => fk.refTable === 'Organization')
      expect(orgFk).toBeDefined()
      expect(orgFk?.columns).toEqual(['organizationId'])
      expect(orgFk?.refColumns).toEqual(['id'])

      const selfFk = tableDef.foreignKeys.find((fk) => fk.refTable === 'Team')
      expect(selfFk).toBeDefined()
      expect(selfFk?.columns).toEqual(['parentId'])
    })

    test('renders Organization CREATE TABLE SQL', () => {
      const tableDef = generateTableDDL('Organization', testSchema.definitions.Organization)
      const sql = renderCreateTableSQL(tableDef)

      console.log('\n--- Organization Table DDL ---')
      console.log(sql)
      console.log('---\n')

      expect(sql).toContain('CREATE TABLE "Organization"')
      expect(sql).toContain('"id" uuid PRIMARY KEY')
      expect(sql).toContain('"name" varchar NOT NULL')
      expect(sql).toContain('"createdAt" timestamptz')
      expect(sql).not.toContain('FOREIGN KEY')
    })

    test('renders Team CREATE TABLE SQL with foreign keys', () => {
      const tableDef = generateTableDDL('Team', testSchema.definitions.Team)
      const sql = renderCreateTableSQL(tableDef)

      console.log('\n--- Team Table DDL ---')
      console.log(sql)
      console.log('---\n')

      expect(sql).toContain('CREATE TABLE "Team"')
      expect(sql).toContain('"id" uuid PRIMARY KEY')
      expect(sql).toContain('"organizationId" varchar NOT NULL')
      expect(sql).toContain('"parentId" varchar')
      expect(sql).toContain('CONSTRAINT "fk_Team_organizationId"')
      expect(sql).toContain('FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id")')
      expect(sql).toContain('CONSTRAINT "fk_Team_parentId"')
      expect(sql).toContain('FOREIGN KEY ("parentId") REFERENCES "Team" ("id")')
    })
  })

  describe('Kysely-Style Fluent API', () => {
    test('builds Organization table with fluent API', () => {
      const sql = buildKyselyStyleDDL('Organization', testSchema.definitions.Organization)

      console.log('\n--- Kysely-Style Organization DDL ---')
      console.log(sql)
      console.log('---\n')

      expect(sql).toContain('CREATE TABLE "Organization"')
      expect(sql).toContain('"id" uuid PRIMARY KEY')
      expect(sql).toContain('"name" varchar NOT NULL')
      expect(sql).toContain('"createdAt" timestamptz')
    })

    test('builds Team table with foreign keys using fluent API', () => {
      const sql = buildKyselyStyleDDL('Team', testSchema.definitions.Team)

      console.log('\n--- Kysely-Style Team DDL ---')
      console.log(sql)
      console.log('---\n')

      expect(sql).toContain('CREATE TABLE "Team"')
      expect(sql).toContain('"id" uuid PRIMARY KEY')
      expect(sql).toContain('"organizationId" varchar NOT NULL')
      expect(sql).toContain('CONSTRAINT "fk_Team_organizationId"')
      expect(sql).toContain('FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id")')
      expect(sql).toContain('CONSTRAINT "fk_Team_parentId"')
      expect(sql).toContain('FOREIGN KEY ("parentId") REFERENCES "Team" ("id")')
    })
  })

  describe('Edge Cases', () => {
    test('handles optional references (nullable foreign keys)', () => {
      const tableDef = generateTableDDL('Team', testSchema.definitions.Team)
      const parentIdCol = tableDef.columns.find((c) => c.name === 'parentId')

      // parentId is not in required array, so notNull should be false
      expect(parentIdCol?.notNull).toBe(false)
    })

    test('handles self-referencing tables', () => {
      const tableDef = generateTableDDL('Team', testSchema.definitions.Team)
      const selfFk = tableDef.foreignKeys.find(
        (fk) => fk.refTable === 'Team' && fk.columns.includes('parentId')
      )

      expect(selfFk).toBeDefined()
      expect(selfFk?.refTable).toBe('Team')
    })

    test('PRIMARY KEY implies NOT NULL (does not duplicate)', () => {
      const sql = buildKyselyStyleDDL('Organization', testSchema.definitions.Organization)

      // Should have PRIMARY KEY but not redundant NOT NULL
      expect(sql).toContain('"id" uuid PRIMARY KEY')
      expect(sql).not.toContain('"id" uuid PRIMARY KEY NOT NULL')
    })
  })

  describe('Topological Sort Requirement', () => {
    test('documents dependency order (Organization before Team)', () => {
      // This test documents the need for topological sorting
      // Team references Organization, so Organization must be created first

      const orgSQL = renderCreateTableSQL(
        generateTableDDL('Organization', testSchema.definitions.Organization)
      )
      const teamSQL = renderCreateTableSQL(generateTableDDL('Team', testSchema.definitions.Team))

      // If we tried to execute these in wrong order, Team would fail
      // because Organization doesn't exist yet

      console.log('\n--- Correct Execution Order ---')
      console.log('1. Create Organization (no dependencies)')
      console.log('2. Create Team (depends on Organization)')
      console.log('---\n')

      expect(teamSQL).toContain('REFERENCES "Organization"')
    })
  })
})

describe('Kysely Integration Points', () => {
  test('documents how real Kysely code would look', () => {
    // If we installed Kysely, the code would be:
    //
    // import { Kysely, PostgresDialect, sql } from 'kysely'
    // import { Pool } from 'pg'
    //
    // const db = new Kysely<any>({
    //   dialect: new PostgresDialect({ pool: new Pool({ connectionString: '...' }) })
    // })
    //
    // await db.schema
    //   .createTable('Organization')
    //   .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    //   .addColumn('name', 'varchar', (col) => col.notNull())
    //   .addColumn('createdAt', 'timestamptz')
    //   .execute()
    //
    // await db.schema
    //   .createTable('Team')
    //   .addColumn('id', 'uuid', (col) => col.primaryKey())
    //   .addColumn('name', 'varchar', (col) => col.notNull())
    //   .addColumn('organizationId', 'varchar', (col) => col.notNull())
    //   .addColumn('parentId', 'varchar')
    //   .addForeignKeyConstraint('fk_Team_organizationId', ['organizationId'], 'Organization', ['id'])
    //   .addForeignKeyConstraint('fk_Team_parentId', ['parentId'], 'Team', ['id'])
    //   .execute()

    expect(true).toBe(true)
  })

  test('documents migration file structure', () => {
    // Kysely migrations are typically structured as:
    //
    // migrations/
    //   001_create_organization.ts
    //   002_create_team.ts
    //
    // Each file exports `up` and `down` functions:
    //
    // export async function up(db: Kysely<any>): Promise<void> {
    //   await db.schema.createTable('Organization')...
    // }
    //
    // export async function down(db: Kysely<any>): Promise<void> {
    //   await db.schema.dropTable('Organization').execute()
    // }

    expect(true).toBe(true)
  })
})

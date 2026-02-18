/**
 * Namespace derivation and table qualification utilities
 *
 * This module provides utilities for schema namespace isolation:
 * - Deriving SQL-safe namespace names from Shogo schema names
 * - Generating dialect-specific qualified table names
 *
 * PostgreSQL uses native database schemas: "namespace"."table"
 * SQLite uses table name prefixing: namespace__table
 *
 * @module ddl/namespace
 */

/**
 * Derives SQL-safe namespace identifier from a Shogo schema name.
 *
 * Transforms the schema name to be safe for use as:
 * - PostgreSQL schema name (CREATE SCHEMA "namespace")
 * - SQLite table prefix (namespace__tablename)
 *
 * Transformation rules:
 * - Convert PascalCase/camelCase to snake_case
 * - Replace hyphens with underscores
 * - Replace special characters with underscores
 * - Convert to lowercase
 * - Collapse multiple consecutive underscores
 * - Prepend underscore if starts with digit
 * - Trim trailing underscores
 *
 * @param {string} schemaName - Shogo schema name
 * @returns {string} SQL-safe namespace identifier
 *
 * @example
 * ```ts
 * deriveNamespace("my-app-schema")   // "my_app_schema"
 * deriveNamespace("MyAppSchema")     // "my_app_schema"
 * deriveNamespace("myAppSchema")     // "my_app_schema"
 * deriveNamespace("123schema")       // "_123schema"
 * deriveNamespace("my.app@schema!")  // "my_app_schema"
 * ```
 */
export function deriveNamespace(schemaName: string): string {
  let result = schemaName
    // Insert underscore before uppercase letters that follow lowercase letters (camelCase)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    // Insert underscore before uppercase letters followed by lowercase (handles acronyms)
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    // Convert to lowercase
    .toLowerCase()
    // Replace hyphens with underscores
    .replace(/-/g, "_")
    // Replace any other non-alphanumeric characters (except underscore) with underscore
    .replace(/[^a-z0-9_]/g, "_")
    // Collapse multiple consecutive underscores to single underscore
    .replace(/_+/g, "_")
    // Trim leading underscores (we'll add one back if needed for numeric prefix)
    .replace(/^_+/, "")
    // Trim trailing underscores
    .replace(/_+$/, "")

  // Prepend underscore if starts with digit (SQL identifiers can't start with digit)
  if (/^[0-9]/.test(result)) {
    result = "_" + result
  }

  return result
}

/**
 * Type for SQL dialect name used in table qualification
 */
export type QualifyDialect = "postgresql" | "sqlite"

/**
 * Creates a dialect-specific qualified table name from namespace and table.
 *
 * For PostgreSQL:
 * - Returns fully qualified name: "namespace"."tablename"
 * - Escapes embedded double quotes by doubling them
 * - With empty namespace, returns just the quoted table name
 *
 * For SQLite:
 * - Returns prefixed name: namespace__tablename
 * - Uses double underscore as separator
 * - With empty namespace, returns just the table name
 *
 * @param {string} namespace - SQL-safe namespace (from deriveNamespace)
 * @param {string} tableName - Table name (typically from toSnakeCase)
 * @param {QualifyDialect} dialect - Target SQL dialect
 * @returns {string} Qualified table name for the dialect
 *
 * @example
 * ```ts
 * // PostgreSQL
 * qualifyTableName("my_app", "user", "postgresql")           // '"my_app"."user"'
 * qualifyTableName("my_app", "team_member", "postgresql")    // '"my_app"."team_member"'
 * qualifyTableName("", "user", "postgresql")                 // '"user"'
 *
 * // SQLite
 * qualifyTableName("my_app", "user", "sqlite")               // "my_app__user"
 * qualifyTableName("my_app", "team_member", "sqlite")        // "my_app__team_member"
 * qualifyTableName("", "user", "sqlite")                     // "user"
 * ```
 */
export function qualifyTableName(
  namespace: string,
  tableName: string,
  dialect: QualifyDialect
): string {
  if (dialect === "postgresql") {
    return qualifyTableNamePostgres(namespace, tableName)
  } else {
    return qualifyTableNameSqlite(namespace, tableName)
  }
}

/**
 * PostgreSQL-specific table name qualification.
 * Returns fully qualified "namespace"."tablename" with proper escaping.
 */
function qualifyTableNamePostgres(namespace: string, tableName: string): string {
  const escapedTable = escapePostgresIdentifier(tableName)

  if (!namespace) {
    return escapedTable
  }

  const escapedNamespace = escapePostgresIdentifier(namespace)
  return `${escapedNamespace}.${escapedTable}`
}

/**
 * SQLite-specific table name qualification.
 * Returns prefixed namespace__tablename.
 */
function qualifyTableNameSqlite(namespace: string, tableName: string): string {
  if (!namespace) {
    return tableName
  }

  return `${namespace}__${tableName}`
}

/**
 * Escapes a PostgreSQL identifier by wrapping in double quotes
 * and doubling any embedded double quotes.
 */
function escapePostgresIdentifier(identifier: string): string {
  // Double any embedded double quotes for PostgreSQL escaping
  const escaped = identifier.replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * Normalizes a table name for comparison by stripping quotes and converting to lowercase.
 *
 * This function enables comparing table names from different sources:
 * - qualifyTableName() returns quoted PostgreSQL names: "schema"."table"
 * - introspection returns unquoted names: schema.table
 *
 * After normalization, both formats become comparable: schema.table
 *
 * @param tableName - Table name in any format (quoted or unquoted)
 * @returns Normalized table name (unquoted, lowercase)
 *
 * @example
 * ```ts
 * normalizeTableNameForComparison('"studio_chat"."chat_session"')  // "studio_chat.chat_session"
 * normalizeTableNameForComparison('studio_chat.chat_session')       // "studio_chat.chat_session"
 * normalizeTableNameForComparison('Studio_Chat.Chat_Session')       // "studio_chat.chat_session"
 * normalizeTableNameForComparison('"user"')                         // "user"
 * normalizeTableNameForComparison('"my""app"."user"')               // 'my"app.user'
 * ```
 */
export function normalizeTableNameForComparison(tableName: string): string {
  // Step 1: Handle PostgreSQL quoted identifiers
  // Pattern matches: "identifier" or "schema"."table"
  // We need to:
  // 1. Remove surrounding double quotes from each part
  // 2. Unescape doubled double quotes ("") back to single (")

  let result = tableName

  // If the string contains quoted identifiers, process them
  if (result.includes('"')) {
    // Split by "." but only if the dot is between quoted identifiers
    // This regex matches quoted identifiers and preserves the structure
    const parts: string[] = []
    let current = ""
    let inQuote = false

    for (let i = 0; i < result.length; i++) {
      const char = result[i]

      if (char === '"') {
        if (inQuote && result[i + 1] === '"') {
          // Escaped quote ("") - keep one quote
          current += '"'
          i++ // Skip the next quote
        } else {
          // Toggle quote state
          inQuote = !inQuote
        }
      } else if (char === '.' && !inQuote) {
        // Separator between schema and table
        parts.push(current)
        current = ""
      } else {
        current += char
      }
    }

    // Don't forget the last part
    if (current) {
      parts.push(current)
    }

    result = parts.join(".")
  }

  // Step 2: Convert to lowercase for case-insensitive comparison
  return result.toLowerCase()
}

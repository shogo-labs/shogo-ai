/**
 * Unit tests for namespace derivation and table qualification
 *
 * Tests conversion of Wavesmith schema names to SQL-safe namespace identifiers
 * and generation of dialect-specific qualified table names.
 */

import { describe, test, expect } from "bun:test"
import { deriveNamespace, qualifyTableName } from "../namespace"

describe("deriveNamespace", () => {
  /**
   * Test: Convert hyphenated schema name to underscore namespace
   * Given: Schema name "my-app-schema" with hyphens
   * When: deriveNamespace is called
   * Then: Returns "my_app_schema" with hyphens replaced by underscores
   */
  test("converts hyphenated schema name to underscore namespace", () => {
    expect(deriveNamespace("my-app-schema")).toBe("my_app_schema")
  })

  /**
   * Test: Convert PascalCase schema name to lowercase underscore
   * Given: Schema name "MyAppSchema" in PascalCase
   * When: deriveNamespace is called
   * Then: Returns "my_app_schema" in lowercase with underscores
   */
  test("converts PascalCase schema name to lowercase underscore", () => {
    expect(deriveNamespace("MyAppSchema")).toBe("my_app_schema")
  })

  /**
   * Test: Convert camelCase schema name to lowercase underscore
   * Given: Schema name "myAppSchema" in camelCase
   * When: deriveNamespace is called
   * Then: Returns "my_app_schema" in lowercase with underscores
   */
  test("converts camelCase schema name to lowercase underscore", () => {
    expect(deriveNamespace("myAppSchema")).toBe("my_app_schema")
  })

  /**
   * Test: Handle already snake_case names
   * Given: Schema name "my_app_schema" already in snake_case
   * When: deriveNamespace is called
   * Then: Returns unchanged "my_app_schema"
   */
  test("handles already snake_case names", () => {
    expect(deriveNamespace("my_app_schema")).toBe("my_app_schema")
  })

  /**
   * Test: Replace special characters with underscores
   * Given: Schema name with dots, at signs, and other special chars
   * When: deriveNamespace is called
   * Then: Returns string with special chars replaced by underscores (trailing trimmed)
   */
  test("replaces special characters with underscores", () => {
    expect(deriveNamespace("my.app@schema")).toBe("my_app_schema")
  })

  /**
   * Test: Handle numeric prefix by prepending underscore
   * Given: Schema name starting with digit "123schema"
   * When: deriveNamespace is called
   * Then: Returns "_123schema" with underscore prepended (SQL identifiers can't start with digit)
   */
  test("handles numeric prefixes by prepending underscore", () => {
    expect(deriveNamespace("123schema")).toBe("_123schema")
  })

  /**
   * Test: Handle single lowercase word
   * Given: Simple schema name "inventory"
   * When: deriveNamespace is called
   * Then: Returns unchanged "inventory"
   */
  test("handles single lowercase word", () => {
    expect(deriveNamespace("inventory")).toBe("inventory")
  })

  /**
   * Test: Handle consecutive capitals (acronyms)
   * Given: Schema name with acronym "HTTPSServer"
   * When: deriveNamespace is called
   * Then: Returns "https_server" with proper underscore placement
   */
  test("handles consecutive capitals (acronyms)", () => {
    expect(deriveNamespace("HTTPSServer")).toBe("https_server")
  })

  /**
   * Test: Handle mixed hyphens and camelCase
   * Given: Schema name mixing conventions "my-AppSchema-v2"
   * When: deriveNamespace is called
   * Then: Returns consistent snake_case "my_app_schema_v2"
   */
  test("handles mixed hyphens and camelCase", () => {
    expect(deriveNamespace("my-AppSchema-v2")).toBe("my_app_schema_v2")
  })

  /**
   * Test: Collapse multiple underscores
   * Given: Schema name that would produce multiple consecutive underscores
   * When: deriveNamespace is called
   * Then: Returns string with single underscores only
   */
  test("collapses multiple underscores", () => {
    expect(deriveNamespace("my--app__schema")).toBe("my_app_schema")
  })

  /**
   * Test: Trim trailing underscores
   * Given: Schema name that ends with special characters
   * When: deriveNamespace is called
   * Then: Returns string without trailing underscores
   */
  test("trims trailing underscores", () => {
    expect(deriveNamespace("myschema-")).toBe("myschema")
  })
})

describe("qualifyTableName", () => {
  /**
   * Test: PostgreSQL returns fully qualified name with quotes
   * Given: Namespace "my_app" and table "user"
   * When: qualifyTableName is called with dialect "postgresql"
   * Then: Returns '"my_app"."user"' with both parts quoted
   */
  test("PostgreSQL: returns fully qualified name with quotes", () => {
    expect(qualifyTableName("my_app", "user", "postgresql")).toBe('"my_app"."user"')
  })

  /**
   * Test: SQLite returns prefixed name with double underscore
   * Given: Namespace "my_app" and table "user"
   * When: qualifyTableName is called with dialect "sqlite"
   * Then: Returns "my_app__user" with double underscore separator
   */
  test("SQLite: returns prefixed name with double underscore", () => {
    expect(qualifyTableName("my_app", "user", "sqlite")).toBe("my_app__user")
  })

  /**
   * Test: PostgreSQL escapes quotes in namespace
   * Given: Namespace with embedded double quote
   * When: qualifyTableName is called with dialect "postgresql"
   * Then: Returns properly escaped name with doubled quotes
   */
  test("PostgreSQL: escapes quotes in namespace", () => {
    expect(qualifyTableName('my"app', "user", "postgresql")).toBe('"my""app"."user"')
  })

  /**
   * Test: PostgreSQL escapes quotes in table name
   * Given: Table name with embedded double quote
   * When: qualifyTableName is called with dialect "postgresql"
   * Then: Returns properly escaped name with doubled quotes
   */
  test("PostgreSQL: escapes quotes in table name", () => {
    expect(qualifyTableName("my_app", 'user"name', "postgresql")).toBe('"my_app"."user""name"')
  })

  /**
   * Test: SQLite handles special characters in namespace
   * Given: Namespace with special characters (already sanitized via deriveNamespace)
   * When: qualifyTableName is called with dialect "sqlite"
   * Then: Returns prefixed name (SQLite table names don't need escaping in this context)
   */
  test("SQLite: handles underscores in namespace", () => {
    expect(qualifyTableName("my_app_v2", "user", "sqlite")).toBe("my_app_v2__user")
  })

  /**
   * Test: PostgreSQL with complex table name
   * Given: Namespace and table name with snake_case
   * When: qualifyTableName is called with dialect "postgresql"
   * Then: Returns properly qualified and quoted name
   */
  test("PostgreSQL: handles snake_case table names", () => {
    expect(qualifyTableName("inventory", "team_member", "postgresql")).toBe('"inventory"."team_member"')
  })

  /**
   * Test: SQLite with complex table name
   * Given: Namespace and table name with snake_case
   * When: qualifyTableName is called with dialect "sqlite"
   * Then: Returns properly prefixed name
   */
  test("SQLite: handles snake_case table names", () => {
    expect(qualifyTableName("inventory", "team_member", "sqlite")).toBe("inventory__team_member")
  })
})

describe("qualifyTableName without namespace", () => {
  /**
   * Test: PostgreSQL without namespace returns simple quoted table name
   * Given: Empty namespace and table "user"
   * When: qualifyTableName is called with dialect "postgresql"
   * Then: Returns just '"user"' without namespace prefix
   */
  test("PostgreSQL: empty namespace returns simple quoted table name", () => {
    expect(qualifyTableName("", "user", "postgresql")).toBe('"user"')
  })

  /**
   * Test: SQLite without namespace returns simple table name
   * Given: Empty namespace and table "user"
   * When: qualifyTableName is called with dialect "sqlite"
   * Then: Returns just "user" without namespace prefix
   */
  test("SQLite: empty namespace returns simple table name", () => {
    expect(qualifyTableName("", "user", "sqlite")).toBe("user")
  })
})

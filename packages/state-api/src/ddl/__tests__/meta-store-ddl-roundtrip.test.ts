/**
 * Integration test: Meta-store roundtrip → DDL generation
 *
 * Tests the full pipeline:
 * 1. Ingest Enhanced JSON Schema into meta-store
 * 2. Extract via toEnhancedJson
 * 3. Generate DDL via generateSQL
 *
 * This catches issues where schema information is lost during the
 * meta-store roundtrip (ingest → store → extract).
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createMetaStore } from "../../meta/meta-store"
import { generateSQL } from "../sql-generator"
import { createPostgresDialect } from "../dialect"

describe("meta-store DDL roundtrip", () => {
  let metaStore: any

  beforeEach(() => {
    const { createStore } = createMetaStore()
    metaStore = createStore()
  })

  /**
   * Test Specification: test-meta-ddl-roundtrip-object-type
   * Scenario: Object type properties preserve type through meta-store roundtrip
   *
   * Given: Schema with property type: "object" with nested properties
   * When: Schema is ingested, extracted via toEnhancedJson, and DDL generated
   * Then: The object property generates JSONB column (not TEXT)
   *
   * This is a regression test for the issue where object types were
   * being lost or incorrectly mapped during the meta-store roundtrip.
   */
  test("object type properties generate JSONB after meta-store roundtrip", () => {
    // 1. Create schema with object type property
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        FeatureSession: {
          type: "object",
          properties: {
            id: {
              type: "string",
              "x-mst-type": "identifier",
            },
            name: {
              type: "string",
            },
            // Object type with nested properties
            initialAssessment: {
              type: "object",
              description: "Preliminary assessment data",
              properties: {
                likelyArchetype: {
                  type: "string",
                  enum: ["service", "domain", "infrastructure", "hybrid"],
                },
                indicators: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
            // Array type for comparison
            affectedPackages: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["id", "name"],
        },
      },
    }

    // 2. Ingest into meta-store
    metaStore.ingestEnhancedJsonSchema(inputSchema, { name: "test-schema" })

    // 3. Extract via toEnhancedJson
    const schema = metaStore.findSchemaByName("test-schema")
    expect(schema).toBeDefined()

    const extractedSchema = schema.toEnhancedJson

    // DEBUG: Log what we got back
    console.log("\n=== Extracted Schema ===")
    console.log(JSON.stringify(extractedSchema.$defs?.FeatureSession?.properties?.initialAssessment, null, 2))

    // 4. Verify object type is preserved in extracted schema
    const initialAssessmentProp = extractedSchema.$defs?.FeatureSession?.properties?.initialAssessment
    expect(initialAssessmentProp).toBeDefined()
    expect(initialAssessmentProp.type).toBe("object") // <-- THIS IS THE KEY ASSERTION

    // 5. Generate DDL
    const dialect = createPostgresDialect()
    const ddl = generateSQL(extractedSchema, dialect)

    // 6. Find the CREATE TABLE statement
    const createTable = ddl.find((s) => s.includes('"feature_session"'))
    expect(createTable).toBeDefined()

    console.log("\n=== Generated DDL ===")
    console.log(createTable)

    // 7. Object property should be JSONB
    expect(createTable).toContain('"initial_assessment" JSONB')

    // 8. Array property should also be JSONB
    expect(createTable).toContain('"affected_packages" JSONB')
  })
})

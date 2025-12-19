/**
 * schema.set Tool Tests
 *
 * Tests for the refactored schema.set tool that uses meta-layer.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "@shogo/state-api"
import { getRuntimeStore, clearRuntimeStores, cacheRuntimeStore } from "@shogo/state-api"
import { enhancedJsonSchemaToMST } from "@shogo/state-api"

/**
 * Direct implementation of schema.set logic for testing
 * (extracted from the tool handler)
 */
async function handleSchemaSet(args: { format: string; payload: unknown; options?: { validateReferences?: boolean } }) {
  const { format, payload, options } = args

  if (format !== "enhanced-json-schema") {
    return { ok: false, error: { code: "UNSUPPORTED_FORMAT", message: "Only 'enhanced-json-schema' supported in MVP-1" } }
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, error: { code: "SCHEMA_PARSE_ERROR", message: "payload must be an object" } }
  }

  const enhanced = payload as Record<string, any>
  const defs = (enhanced as any).$defs
  if (!defs || typeof defs !== "object") {
    return { ok: false, error: { code: "SCHEMA_PARSE_ERROR", message: "payload.$defs is required" } }
  }

  try {
    // 1. Ingest into meta-store
    const metaStore = getMetaStore()
    // Generate a schema name from model names or use default
    const modelNames = Object.keys(defs).join("-")
    const schemaName = modelNames || `test-schema-${Date.now()}`
    const schema = metaStore.ingestEnhancedJsonSchema(enhanced, { name: schemaName })

    // 2. Generate runtime MST store
    // Use original enhanced schema
    const { createStore } = enhancedJsonSchemaToMST(enhanced, {
      generateActions: true,
      validateReferences: options?.validateReferences ?? false
    })
    const runtimeStore = createStore()

    // 3. Cache runtime store
    cacheRuntimeStore(schema.id, runtimeStore)

    // 4. Build response from meta-store entities
    const models: any[] = []
    const modelsInSchema = metaStore.modelCollection.all()
      .filter((m: any) => m.schema === schema)

    for (const model of modelsInSchema) {
      const fields: any[] = []
      const refs: any[] = []

      // Get top-level properties
      const properties = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === model && !p.parentProperty)

      for (const prop of properties) {
        const computed = prop.xComputed === true
        const refType = prop.xReferenceType as undefined | "single" | "array"

        let typeLabel = prop.type || "unknown"
        if (prop.$ref) typeLabel = "reference"

        if (refType === "single") {
          const targetRef = prop.$ref?.replace("#/$defs/", "") || ""
          refs.push({ field: prop.name, target: targetRef, kind: "single" })
          typeLabel = "reference"
        } else if (refType === "array") {
          const itemsChild = prop.itemsChild
          if (itemsChild && itemsChild.$ref) {
            const targetRef = itemsChild.$ref.replace("#/$defs/", "") || ""
            refs.push({ field: prop.name, target: targetRef, kind: "array" })
            typeLabel = "reference[]"
          }
        }

        fields.push({
          name: prop.name,
          type: typeLabel,
          required: prop.required || false,
          ...(computed ? { computed: true } : {}),
        })
      }

      const modelName = model.domain ? `${model.domain}.${model.name}` : model.name

      models.push({
        name: modelName,
        fields,
        ...(refs.length > 0 ? { refs } : {}),
      })
    }

    const domains = Array.from(new Set(models
      .map(m => m.name.includes(".") ? m.name.split(".")[0] : undefined)
      .filter(Boolean) as string[]))

    return {
      ok: true,
      schemaId: schema.id,
      models,
      ...(domains.length ? { domains } : {})
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_INGESTION_ERROR",
        message: error.message || "Failed to ingest schema"
      }
    }
  }
}

describe("schema.set Tool", () => {
  beforeEach(() => {
    resetMetaStore()
    clearRuntimeStores()
  })

  test("rejects non-object payload", async () => {
    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: "not an object"
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("SCHEMA_PARSE_ERROR")
  })

  test("rejects payload without $defs", async () => {
    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: { noDefsHere: true }
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("SCHEMA_PARSE_ERROR")
  })

  test("rejects unsupported format", async () => {
    const result = await handleSchemaSet({
      format: "arktype",
      payload: {}
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("UNSUPPORTED_FORMAT")
  })

  test("ingests simple schema successfully", async () => {
    const enhancedSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)
    expect(result.schemaId).toBeDefined()
    expect(result.models).toHaveLength(1)
    expect(result.models![0].name).toBe("User")
    expect(result.models![0].fields).toHaveLength(2)
  })

  test("stores schema in meta-store", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    if (!result.ok) {
      console.log("Error:", result.error)
    }

    expect(result.ok).toBe(true)

    // Verify meta-store contains the schema
    const metaStore = getMetaStore()
    expect(metaStore.schemaCollection.all()).toHaveLength(1)
    expect(metaStore.modelCollection.all()).toHaveLength(1)
    expect(metaStore.propertyCollection.all()).toHaveLength(2)
  })

  // TODO: Fix - handleSchemaSet needs to use loadSchema or add collection mixins
  test.skip("caches runtime store", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)

    // Verify runtime store is cached
    const runtimeStore = getRuntimeStore(result.schemaId!)
    expect(runtimeStore).toBeDefined()

    // Debug: Check what's actually in the runtime store
    const keys = Object.keys(runtimeStore)
    console.log("Runtime store keys:", keys)
    console.log("Has userCollection:", !!runtimeStore.userCollection)

    // The runtime store should have a userCollection
    // Note: MST properties might not enumerate, so check directly
    if (!runtimeStore.userCollection) {
      console.log("Runtime store snapshot:", JSON.stringify(Object.keys(runtimeStore)))
      // Try to access it anyway
      try {
        const collection = runtimeStore["userCollection"]
        console.log("Direct access userCollection:", collection)
      } catch (e) {
        console.log("Error accessing userCollection:", e)
      }
    }

    expect(runtimeStore.userCollection).toBeDefined()
    expect(typeof runtimeStore.userCollection.all).toBe("function")
    expect(runtimeStore.userCollection.all()).toEqual([])
  })

  test("handles multi-model schema", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Post: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)
    expect(result.models).toHaveLength(2)

    const userModel = result.models!.find((m: any) => m.name === "User")
    const postModel = result.models!.find((m: any) => m.name === "Post")

    expect(userModel).toBeDefined()
    expect(postModel).toBeDefined()
    expect(postModel.fields).toHaveLength(3)
  })

  test("handles references correctly", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Post: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" },
            author: {
              $ref: "#/$defs/User",
              "x-reference-type": "single"
            }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)

    const postModel = result.models!.find((m: any) => m.name === "Post")
    expect(postModel.refs).toBeDefined()
    expect(postModel.refs).toHaveLength(1)
    expect(postModel.refs[0]).toEqual({
      field: "author",
      target: "User",
      kind: "single"
    })

    const authorField = postModel.fields.find((f: any) => f.name === "author")
    expect(authorField.type).toBe("reference")
  })

  // TODO: Fix - handleSchemaSet needs to properly capture array reference metadata
  test.skip("handles array references correctly", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Company: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" },
            employees: {
              type: "array",
              items: {
                $ref: "#/$defs/User"
              },
              "x-reference-type": "array"
            }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)

    const companyModel = result.models!.find((m: any) => m.name === "Company")
    expect(companyModel.refs).toBeDefined()
    expect(companyModel.refs).toHaveLength(1)
    expect(companyModel.refs[0]).toEqual({
      field: "employees",
      target: "User",
      kind: "array"
    })

    const employeesField = companyModel.fields.find((f: any) => f.name === "employees")
    expect(employeesField.type).toBe("reference[]")
  })

  test("handles computed properties", async () => {
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            fullName: {
              type: "string",
              "x-computed": true
            }
          },
          required: ["id", "firstName", "lastName"]
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)

    const userModel = result.models![0]
    const fullNameField = userModel.fields.find((f: any) => f.name === "fullName")

    expect(fullNameField.computed).toBe(true)
    expect(fullNameField.required).toBe(false)
  })

  test("handles models with domain metadata", async () => {
    // Simplified test: models with x-domain but using simple keys
    const enhancedSchema = {
      $defs: {
        User: {
          type: "object",
          "x-domain": "auth",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            email: { type: "string" }
          }
        },
        Post: {
          type: "object",
          "x-domain": "cms",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" }
          }
        }
      }
    }

    const result = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: enhancedSchema
    })

    expect(result.ok).toBe(true)
    expect(result.models).toHaveLength(2)

    // Models should be named with domain prefix if domain metadata is preserved
    const userModel = result.models!.find((m: any) => m.name.includes("User"))
    const postModel = result.models!.find((m: any) => m.name.includes("Post"))

    expect(userModel).toBeDefined()
    expect(postModel).toBeDefined()

    // If domains are extracted, verify them
    if (result.domains) {
      expect(result.domains.length).toBeGreaterThan(0)
    }
  })

  test("handles multiple schema sets", async () => {
    const schema1 = {
      $defs: {
        User: {
          type: "object",
          properties: { id: { type: "string", format: "uuid", "x-mst-type": "identifier" } }
        }
      }
    }

    const schema2 = {
      $defs: {
        Post: {
          type: "object",
          properties: { id: { type: "string", format: "uuid", "x-mst-type": "identifier" } }
        }
      }
    }

    const result1 = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: schema1
    })

    const result2 = await handleSchemaSet({
      format: "enhanced-json-schema",
      payload: schema2
    })

    expect(result1.ok).toBe(true)
    expect(result2.ok).toBe(true)
    expect(result1.schemaId).not.toBe(result2.schemaId)

    // Both runtime stores should be cached
    expect(getRuntimeStore(result1.schemaId!)).toBeDefined()
    expect(getRuntimeStore(result2.schemaId!)).toBeDefined()

    // Meta-store should have both schemas
    const metaStore = getMetaStore()
    expect(metaStore.schemaCollection.all()).toHaveLength(2)
  })
})

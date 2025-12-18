/**
 * Debug test to understand runtime store structure
 */

import { test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "@shogo/state-api"
import { getRuntimeStore, clearRuntimeStores, cacheRuntimeStore } from "@shogo/state-api"
import { enhancedJsonSchemaToMST } from "@shogo/state-api"

test("debug: check runtime store structure", async () => {
  resetMetaStore()
  clearRuntimeStores()

  const enhancedSchema = {
    $defs: {
      User: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" }
        }
      }
    }
  }

  // Ingest into meta-store
  const metaStore = getMetaStore()
  const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, { name: "debug-test" })

  // Generate runtime MST store
  const { createStore } = enhancedJsonSchemaToMST(enhancedSchema, {
    generateActions: true,
    validateReferences: false
  })
  const runtimeStore = createStore()

  // Cache runtime store
  cacheRuntimeStore(schema.id, runtimeStore)

  // Debug: log the runtime store structure
  console.log("Runtime store keys:", Object.keys(runtimeStore))
  console.log("Schema ID:", schema.id)

  // Try accessing collection directly
  console.log("Has userCollection:", "userCollection" in runtimeStore)
  console.log("userCollection value:", runtimeStore.userCollection)
  console.log("Type of userCollection:", typeof runtimeStore.userCollection)

  const cachedStore = getRuntimeStore(schema.id)
  console.log("Cached store userCollection:", cachedStore?.userCollection)
})

test("debug: check domain-qualified model error", async () => {
  resetMetaStore()
  clearRuntimeStores()

  const enhancedSchema = {
    $defs: {
      "auth.User": {
        type: "object",
        "x-domain": "auth",
        "x-original-name": "User",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          email: { type: "string" }
        }
      }
    }
  }

  try {
    const metaStore = getMetaStore()
    const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema, { name: "domain-test" })

    // Generate runtime MST store
    const { createStore } = enhancedJsonSchemaToMST(enhancedSchema, {
      generateActions: true,
      validateReferences: false
    })
    const runtimeStore = createStore()

    cacheRuntimeStore(schema.id, runtimeStore)

    // Build response - same as in handleSchemaSet
    const models: any[] = []
    const modelsInSchema = metaStore.modelCollection.all()
      .filter((m: any) => m.schema === schema)

    console.log("ModelsInSchema:", modelsInSchema.map((m: any) => ({ name: m.name, domain: m.domain })))

    for (const model of modelsInSchema) {
      const fields: any[] = []
      const refs: any[] = []

      const properties = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === model && !p.parentProperty)

      console.log("Properties for model:", properties.map((p: any) => p.name))

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

    console.log("Final models:", JSON.stringify(models, null, 2))

    const domains = Array.from(new Set(models
      .map(m => m.name.includes(".") ? m.name.split(".")[0] : undefined)
      .filter(Boolean) as string[]))

    console.log("Domains:", domains)

    const result = {
      ok: true,
      schemaId: schema.id,
      models,
      ...(domains.length ? { domains } : {})
    }

    console.log("Result:", JSON.stringify(result, null, 2))
  } catch (error: any) {
    console.log("Error:", error.message)
    console.log("Stack:", error.stack)
  }
})

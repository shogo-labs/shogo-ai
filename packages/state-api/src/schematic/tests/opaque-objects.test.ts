import { describe, test, expect } from "bun:test"
import { getSnapshot } from "mobx-state-tree"
import { enhancedJsonSchemaToMST } from "../enhanced-json-schema-to-mst"

describe("Opaque objects (types.frozen)", () => {
  test("handles required opaque object fields", () => {
    // Given: Schema with opaque config field (type: object, no properties)
    const schema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Step": {
          "type": "object",
          "x-original-name": "Step",
          "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "config": { "type": "object" }  // ← OPAQUE (no properties defined)
          },
          "required": ["id", "name", "config"]
        }
      }
    }

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(schema)

    // Then: Can create instance with arbitrary config object
    const step = result?.models?.Step?.create({
      id: "step-1",
      name: "Parse",
      config: {
        skill: "docx",
        operation: "parse",
        extractSections: true,
        nested: { deep: { value: 42 } }
      }
    })

    // Should preserve exact structure
    expect(step.config.skill).toBe("docx")
    expect(step.config.operation).toBe("parse")
    expect(step.config.extractSections).toBe(true)
    expect(step.config.nested.deep.value).toBe(42)
  })

  test("handles optional opaque object fields", () => {
    // Given: Schema with optional opaque field
    const schema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Task": {
          "type": "object",
          "x-original-name": "Task",
          "properties": {
            "id": { "type": "string" },
            "metadata": { "type": "object" }  // ← OPAQUE, optional
          },
          "required": ["id"]
        }
      }
    }

    const result = enhancedJsonSchemaToMST(schema)

    // When: Creating without optional field
    const task1 = result?.models?.Task?.create({ id: "task-1" })
    expect(task1.metadata).toBeUndefined()

    // When: Creating with optional field
    const task2 = result?.models?.Task?.create({
      id: "task-2",
      metadata: { foo: "bar", baz: [1, 2, 3] }
    })
    expect(task2.metadata.foo).toBe("bar")
    expect(task2.metadata.baz).toEqual([1, 2, 3])
  })

  test("handles arrays of opaque objects", () => {
    // Given: Schema with array of opaque objects
    const schema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Document": {
          "type": "object",
          "x-original-name": "Document",
          "properties": {
            "id": { "type": "string" },
            "sections": {
              "type": "array",
              "items": { "type": "object" }  // ← OPAQUE items
            }
          },
          "required": ["id", "sections"]
        }
      }
    }

    const result = enhancedJsonSchemaToMST(schema)

    // When: Creating with array of arbitrary objects
    const doc = result?.models?.Document?.create({
      id: "doc-1",
      sections: [
        { title: "Intro", content: "..." },
        { title: "Body", paragraphs: ["p1", "p2"] },
        { customField: { deeply: { nested: true } } }
      ]
    })

    expect(doc.sections).toHaveLength(3)
    expect(doc.sections[0].title).toBe("Intro")
    expect(doc.sections[1].paragraphs).toEqual(["p1", "p2"])
    expect(doc.sections[2].customField.deeply.nested).toBe(true)
  })

  test("serializes and deserializes opaque objects correctly", () => {
    // Given: Model with opaque fields
    const schema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Step": {
          "type": "object",
          "x-original-name": "Step",
          "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "config": { "type": "object" }
          },
          "required": ["id", "name", "config"]
        }
      }
    }

    const result = enhancedJsonSchemaToMST(schema)

    // When: Creating instance with complex opaque data
    const original = result?.models?.Step?.create({
      id: "step-1",
      name: "Parse",
      config: {
        skill: "docx",
        nested: { array: [1, 2, 3], obj: { key: "val" } }
      }
    })

    // Get snapshot (serialization)
    const snapshot = getSnapshot(original) as any

    // Then: Snapshot preserves structure
    expect(snapshot.config.skill).toBe("docx")
    expect(snapshot.config.nested.array).toEqual([1, 2, 3])
    expect(snapshot.config.nested.obj.key).toBe("val")

    // When: Recreating from snapshot (deserialization)
    const restored = result?.models?.Step?.create(snapshot)

    // Then: Data is identical
    expect(restored.config.skill).toBe("docx")
    expect(restored.config.nested.array).toEqual([1, 2, 3])
    expect(restored.config.nested.obj.key).toBe("val")
  })

  test("handles mixed schema with both opaque and structured objects", () => {
    // Given: Schema mixing opaque config with structured properties
    const schema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Instance": {
          "type": "object",
          "x-original-name": "Instance",
          "properties": {
            "id": { "type": "string" },
            "status": {
              "type": "string",
              "enum": ["pending", "running", "completed", "failed"]
            },
            "inputs": { "type": "object" },   // ← OPAQUE
            "outputs": { "type": "object" }   // ← OPAQUE
          },
          "required": ["id", "status"]
        }
      }
    }

    const result = enhancedJsonSchemaToMST(schema)

    // When: Creating with opaque fields
    const instance = result?.models?.Instance?.create({
      id: "inst-1",
      status: "running",
      inputs: {
        contractFile: "/path/to/contract.docx",
        templateFile: "/path/to/template.docx"
      },
      outputs: {
        sections: [
          { title: "Section 1", content: "..." },
          { title: "Section 2", content: "..." }
        ],
        metadata: { processedAt: Date.now() }
      }
    })

    // Then: All fields work correctly
    expect(instance.status).toBe("running")
    expect(instance.inputs.contractFile).toBe("/path/to/contract.docx")
    expect(instance.outputs.sections).toHaveLength(2)
    expect(instance.outputs.metadata.processedAt).toBeGreaterThan(0)
  })
})

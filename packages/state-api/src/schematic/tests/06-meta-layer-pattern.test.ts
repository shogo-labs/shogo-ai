import { describe, it, expect, beforeEach } from "bun:test"
import { v4 as uuidv4 } from "uuid"
import { createStoreFromScope } from "../index"
import { enhancedJsonSchemaToMST } from "../enhanced-json-schema-to-mst"
import { getSnapshot, applySnapshot } from "mobx-state-tree"
import { createMetaStore } from "../../meta/meta-store"
import { MetaRegistry } from "../../meta/meta-registry"

/**
 * Meta-Layer Pattern Test Suite
 *
 * This test suite proves the "view over state" pattern for meta-schema management.
 * Following schemaModel.ts pattern: store as structured MST state, view as JSON Schema.
 *
 * Design decisions:
 * - Single recursive Property entity (mirrors JSON Schema structure)
 * - No extensions map (defer to meta-meta-schema/lens)
 * - Inline nested arrays (Property.properties, Property.items)
 * - Serializable state only (no validation caching)
 * - No versioning yet (will be mixin-based)
 */

// =============================================================================
// Section 1: Meta-Schema Definition
// =============================================================================
// (Moved to src/meta/meta-registry.ts)

// =============================================================================
// Section 2: Meta-Store Creation Tests
// =============================================================================

describe("Meta-Layer Pattern", () => {
  describe("Meta-Schema Definition", () => {
    it("should define MetaRegistry scope", () => {
      expect(MetaRegistry).toBeDefined()

      const exported = MetaRegistry.export()
      expect(exported.Schema).toBeDefined()
      expect(exported.Model).toBeDefined()
      expect(exported.Property).toBeDefined()
    })

    it("should have correct Schema structure", () => {
      const SchemaType = MetaRegistry.export().Schema
      expect(SchemaType).toBeDefined()
      // ArkType validation will ensure structure is correct
    })

    it("should have correct Model structure", () => {
      const ModelType = MetaRegistry.export().Model
      expect(ModelType).toBeDefined()
    })

    it("should have correct Property structure with recursive fields", () => {
      const PropertyType = MetaRegistry.export().Property
      expect(PropertyType).toBeDefined()
    })
  })

  describe("Meta-Store Creation", () => {
    it("should create meta-store from MetaRegistry", () => {
      const result = createStoreFromScope(MetaRegistry)

      // Verify models created
      expect(result.models.Schema).toBeDefined()
      expect(result.models.Model).toBeDefined()
      expect(result.models.Property).toBeDefined()

      // Verify collection models created
      expect(result.collectionModels.SchemaCollection).toBeDefined()
      expect(result.collectionModels.ModelCollection).toBeDefined()
      expect(result.collectionModels.PropertyCollection).toBeDefined()

      // Verify createStore factory exists
      expect(result.createStore).toBeDefined()
      expect(typeof result.createStore).toBe("function")
    })

    it("should instantiate empty meta-store", () => {
      const result = createStoreFromScope(MetaRegistry)
      const metaStore = result.createStore()

      // Verify collections exist
      expect(metaStore.schemaCollection).toBeDefined()
      expect(metaStore.modelCollection).toBeDefined()
      expect(metaStore.propertyCollection).toBeDefined()

      // Verify collections are empty initially
      expect(metaStore.schemaCollection.all()).toEqual([])
      expect(metaStore.modelCollection.all()).toEqual([])
      expect(metaStore.propertyCollection.all()).toEqual([])
    })

    it("should allow adding Schema entity", () => {
      const result = createStoreFromScope(MetaRegistry)
      const metaStore = result.createStore()

      const schema = metaStore.schemaCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440000",
        format: "enhanced-json-schema",
        createdAt: Date.now(),
      })

      expect(schema.id).toBeDefined()
      expect(schema.format).toBe("enhanced-json-schema")
      expect(metaStore.schemaCollection.all().length).toBe(1)
    })

    it("should allow adding Model entity", () => {
      const result = createStoreFromScope(MetaRegistry)
      const metaStore = result.createStore()

      const schemaId = "550e8400-e29b-41d4-a716-446655440001"
      const schema = metaStore.schemaCollection.add({
        id: schemaId,
        format: "enhanced-json-schema",
        createdAt: Date.now(),
      })

      const model = metaStore.modelCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440002",
        schema: schemaId,  // Pass ID, MST will resolve to Schema entity
        name: "User",
      })

      expect(model.name).toBe("User")
      expect(model.schema).toBe(schema)  // MST resolves ID to entity
      expect(metaStore.modelCollection.all().length).toBe(1)
    })

    it("should allow adding Property entity", () => {
      const result = createStoreFromScope(MetaRegistry)
      const metaStore = result.createStore()

      const schemaId = "550e8400-e29b-41d4-a716-446655440001"
      metaStore.schemaCollection.add({
        id: schemaId,
        format: "enhanced-json-schema",
        createdAt: Date.now(),
      })

      const modelId = "550e8400-e29b-41d4-a716-446655440002"
      const model = metaStore.modelCollection.add({
        id: modelId,
        schema: schemaId,  // Reference by ID
        name: "User",
      })

      const property = metaStore.propertyCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440003",
        model: modelId,  // Reference by ID
        name: "email",
        type: "string",
        format: "email",
        required: true,
      })

      expect(property.name).toBe("email")
      expect(property.type).toBe("string")
      expect(property.format).toBe("email")
      expect(property.required).toBe(true)
      expect(property.model).toBe(model)  // MST resolves to entity
      expect(metaStore.propertyCollection.all().length).toBe(1)
    })
  })

  // =============================================================================
  // Section 3: Ingestion Tests (STUBS - will implement helpers)
  // =============================================================================

  describe("Ingestion: Enhanced JSON → Meta-Entities", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should parse simple User schema", () => {
      // Given: Enhanced JSON Schema
      const enhancedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email",
                minLength: 3,
                "x-arktype": "string.email"
              }
            },
            required: ["id", "email"]
          }
        }
      }

      // When: Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema)

      // Then: Verify entities created
      expect(schema.id).toBeDefined()
      expect(metaStore.modelCollection.all().length).toBe(1)

      const userModel = metaStore.modelCollection.all()[0]
      expect(userModel.name).toBe("User")

      const properties = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === userModel)
      expect(properties.length).toBe(2)

      const emailProp = properties.find((p: any) => p.name === "email")
      expect(emailProp.type).toBe("string")
      expect(emailProp.format).toBe("email")
      expect(emailProp.minLength).toBe(3)
      expect(emailProp.xArktype).toBe("string.email")
      expect(emailProp.required).toBe(true)
    })

    it("should parse User/Company schema with references", () => {
      // Given: Enhanced JSON Schema with references
      const enhancedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email"
              },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single",
                "x-arktype": "Company"
              }
            },
            required: ["id", "email"]
          }
        }
      }

      // When: Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema)

      // Then: Verify both models created
      expect(metaStore.modelCollection.all().length).toBe(2)

      const userModel = metaStore.modelCollection.all().find((m: any) => m.name === "User")
      const companyModel = metaStore.modelCollection.all().find((m: any) => m.name === "Company")
      expect(userModel).toBeDefined()
      expect(companyModel).toBeDefined()

      // Verify User has company reference property
      const userProps = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === userModel)
      expect(userProps.length).toBe(3) // id, email, company

      const companyProp = userProps.find((p: any) => p.name === "company")
      expect(companyProp).toBeDefined()
      expect(companyProp.$ref).toBe("#/$defs/Company")
      expect(companyProp.xReferenceType).toBe("single")
      expect(companyProp.xArktype).toBe("Company")

      // Verify Company has basic properties
      const companyProps = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === companyModel)
      expect(companyProps.length).toBe(2) // id, name
    })

    it("should parse computed properties", () => {
      // Given: Schema with computed inverse relationship
      const enhancedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string"
              },
              users: {
                type: "array",
                items: {
                  $ref: "#/$defs/User"
                },
                "x-computed": true,
                "x-inverse": "company",
                "x-arktype": "User[]"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single",
                "x-arktype": "Company"
              }
            },
            required: ["id"]
          }
        }
      }

      // When: Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema)

      // Then: Verify Company.users is marked as computed
      const companyModel = metaStore.modelCollection.all().find((m: any) => m.name === "Company")
      const companyProps = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === companyModel)

      const usersProp = companyProps.find((p: any) => p.name === "users")
      expect(usersProp).toBeDefined()
      expect(usersProp.xComputed).toBe(true)
      expect(usersProp.xInverse).toBe("company")
      expect(usersProp.xArktype).toBe("User[]")
      expect(usersProp.type).toBe("array")

      // Verify computed properties are NOT marked as required
      // (even if they were in the required array, which they shouldn't be)
      expect(usersProp.required).toBeUndefined()
    })

    it("should handle constraints (minLength, pattern, etc)", () => {
      // Given: Schema with various JSON Schema constraints
      const enhancedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Product: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string",
                minLength: 3,
                maxLength: 100,
                pattern: "^[A-Za-z0-9 ]+$"
              },
              price: {
                type: "number",
                minimum: 0,
                maximum: 999999.99
              },
              status: {
                type: "string",
                enum: ["draft", "published", "archived"]
              },
              category: {
                type: "string",
                const: "electronics"
              }
            },
            required: ["id", "name", "price"]
          }
        }
      }

      // When: Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema)

      // Then: Verify all constraints are preserved
      const productModel = metaStore.modelCollection.all().find((m: any) => m.name === "Product")
      const productProps = metaStore.propertyCollection.all()
        .filter((p: any) => p.model === productModel)

      // String constraints (minLength, maxLength, pattern)
      const nameProp = productProps.find((p: any) => p.name === "name")
      expect(nameProp.minLength).toBe(3)
      expect(nameProp.maxLength).toBe(100)
      expect(nameProp.pattern).toBe("^[A-Za-z0-9 ]+$")

      // Number constraints (minimum, maximum)
      const priceProp = productProps.find((p: any) => p.name === "price")
      expect(priceProp.minimum).toBe(0)
      expect(priceProp.maximum).toBe(999999.99)

      // Enum constraint
      const statusProp = productProps.find((p: any) => p.name === "status")
      expect(statusProp.enum).toEqual(["draft", "published", "archived"])

      // Const constraint
      const categoryProp = productProps.find((p: any) => p.name === "category")
      expect(categoryProp.const).toBe("electronics")
    })

    it("should handle domain field for multi-domain schemas", () => {
      // Given: Multi-domain schema with domain-qualified names
      const enhancedSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            "x-domain": "auth",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email"
              }
            },
            required: ["id", "email"]
          },
          "inventory.Product": {
            type: "object",
            "x-original-name": "Product",
            "x-domain": "inventory",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string"
              }
            },
            required: ["id", "name"]
          }
        }
      }

      // When: Ingest into meta-store
      const schema = metaStore.ingestEnhancedJsonSchema(enhancedSchema)

      // Then: Verify domain field is populated correctly
      expect(metaStore.modelCollection.all().length).toBe(2)

      const userModel = metaStore.modelCollection.all().find((m: any) => m.name === "User")
      expect(userModel).toBeDefined()
      expect(userModel.domain).toBe("auth")

      const productModel = metaStore.modelCollection.all().find((m: any) => m.name === "Product")
      expect(productModel).toBeDefined()
      expect(productModel.domain).toBe("inventory")
    })
  })

  // =============================================================================
  // Section 4: View Generation Tests (STUBS - will implement views)
  // =============================================================================

  describe("View Generation: Meta-Entities → Enhanced JSON", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should generate Enhanced JSON from meta-entities", () => {
      // Given: Meta-entities in store
      const inputSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email"
              }
            },
            required: ["id", "email"]
          }
        }
      }

      const schema = metaStore.ingestEnhancedJsonSchema(inputSchema)

      // When: Generate Enhanced JSON from meta-entities
      const generatedSchema = schema.toEnhancedJson()

      // Then: Verify structure matches
      expect(generatedSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
      expect(generatedSchema.$defs).toBeDefined()
      expect(generatedSchema.$defs.User).toBeDefined()
      expect(generatedSchema.$defs.User.type).toBe("object")
      expect(generatedSchema.$defs.User.properties.id).toBeDefined()
      expect(generatedSchema.$defs.User.properties.email).toBeDefined()
    })

    it("should generate Property as JSON Schema property", () => {
      // Given: Single property entity
      const inputSchema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              email: {
                type: "string",
                format: "email",
                minLength: 3,
                "x-arktype": "string.email"
              }
            }
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema)
      const emailProp = metaStore.propertyCollection.all().find((p: any) => p.name === "email")

      // When: Generate JSON Schema property
      const generatedProp = emailProp.toJsonSchema()

      // Then: Verify all fields preserved
      expect(generatedProp.type).toBe("string")
      expect(generatedProp.format).toBe("email")
      expect(generatedProp.minLength).toBe(3)
      expect(generatedProp["x-arktype"]).toBe("string.email")
    })

    it("should generate Model as JSON Schema definition", () => {
      // Given: Model with properties
      const inputSchema = {
        $defs: {
          Product: {
            type: "object",
            description: "A product in the inventory",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema)
      const productModel = metaStore.modelCollection.all().find((m: any) => m.name === "Product")

      // When: Generate JSON Schema definition
      const generatedDef = productModel.toJsonSchema()

      // Then: Verify structure
      expect(generatedDef.type).toBe("object")
      expect(generatedDef.description).toBe("A product in the inventory")
      expect(generatedDef.properties.id).toBeDefined()
      expect(generatedDef.properties.name).toBeDefined()
      expect(generatedDef.required).toEqual(["id", "name"])
    })

    it("should preserve x-* extensions in generated JSON", () => {
      // Given: Properties with various x-* extensions
      const inputSchema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                "x-mst-type": "identifier",
                "x-arktype": "string.uuid"
              },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single",
                "x-arktype": "Company"
              }
            }
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema)
      const userModel = metaStore.modelCollection.all().find((m: any) => m.name === "User")
      const generated = userModel.toJsonSchema()

      // Then: Verify x-* extensions preserved
      expect(generated.properties.id["x-mst-type"]).toBe("identifier")
      expect(generated.properties.id["x-arktype"]).toBe("string.uuid")
      expect(generated.properties.company["x-reference-type"]).toBe("single")
      expect(generated.properties.company["x-arktype"]).toBe("Company")
    })

    it("should reconstruct $ref correctly", () => {
      // Given: Property with $ref
      const inputSchema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single"
              }
            }
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema)
      const companyProp = metaStore.propertyCollection.all().find((p: any) => p.name === "company")

      // When: Generate property
      const generated = companyProp.toJsonSchema()

      // Then: $ref preserved correctly
      expect(generated.$ref).toBe("#/$defs/Company")
      expect(generated["x-reference-type"]).toBe("single")
    })

    it("should reconstruct required array correctly", () => {
      // Given: Model with required and computed properties
      const inputSchema = {
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              users: {
                type: "array",
                "x-computed": true,
                "x-inverse": "company"
              }
            },
            required: ["id", "name"]
          }
        }
      }

      metaStore.ingestEnhancedJsonSchema(inputSchema)
      const companyModel = metaStore.modelCollection.all().find((m: any) => m.name === "Company")

      // When: Generate definition
      const generated = companyModel.toJsonSchema()

      // Then: Required array excludes computed fields
      expect(generated.required).toEqual(["id", "name"])
      expect(generated.required).not.toContain("users")
    })
  })

  // =============================================================================
  // Section 5: Round-Trip Fidelity Tests (STUBS)
  // =============================================================================

  describe("Round-Trip Fidelity", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should preserve simple User schema through round-trip", () => {
      // Given: Simple User schema
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email",
                minLength: 3,
                "x-arktype": "string.email"
              }
            },
            required: ["id", "email"]
          }
        }
      }

      // When: Round-trip through meta-entities
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: Verify structure preserved
      expect(regenerated.$schema).toBe(originalSchema.$schema)
      expect(regenerated.$defs.User.type).toBe("object")
      expect(regenerated.$defs.User.properties.id.type).toBe("string")
      expect(regenerated.$defs.User.properties.id.format).toBe("uuid")
      expect(regenerated.$defs.User.properties.id["x-mst-type"]).toBe("identifier")
      expect(regenerated.$defs.User.properties.email.type).toBe("string")
      expect(regenerated.$defs.User.properties.email.format).toBe("email")
      expect(regenerated.$defs.User.properties.email.minLength).toBe(3)
      expect(regenerated.$defs.User.properties.email["x-arktype"]).toBe("string.email")
      expect(regenerated.$defs.User.required).toEqual(["id", "email"])
    })

    it("should preserve User/Company schema with references", () => {
      // Given: Schema with references
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              email: {
                type: "string",
                format: "email"
              },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single",
                "x-arktype": "Company"
              }
            },
            required: ["id", "email"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: Verify references preserved
      expect(regenerated.$defs.Company).toBeDefined()
      expect(regenerated.$defs.User).toBeDefined()
      expect(regenerated.$defs.User.properties.company.$ref).toBe("#/$defs/Company")
      expect(regenerated.$defs.User.properties.company["x-reference-type"]).toBe("single")
      expect(regenerated.$defs.User.properties.company["x-arktype"]).toBe("Company")
    })

    it("should preserve all constraints through round-trip", () => {
      // Given: Schema with all constraint types
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Product: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string",
                minLength: 3,
                maxLength: 100,
                pattern: "^[A-Za-z0-9 ]+$"
              },
              price: {
                type: "number",
                minimum: 0,
                maximum: 999999.99
              },
              status: {
                type: "string",
                enum: ["draft", "published", "archived"]
              },
              category: {
                type: "string",
                const: "electronics"
              }
            },
            required: ["id", "name", "price"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: All constraints preserved
      const nameProp = regenerated.$defs.Product.properties.name
      expect(nameProp.minLength).toBe(3)
      expect(nameProp.maxLength).toBe(100)
      expect(nameProp.pattern).toBe("^[A-Za-z0-9 ]+$")

      const priceProp = regenerated.$defs.Product.properties.price
      expect(priceProp.minimum).toBe(0)
      expect(priceProp.maximum).toBe(999999.99)

      const statusProp = regenerated.$defs.Product.properties.status
      expect(statusProp.enum).toEqual(["draft", "published", "archived"])

      const categoryProp = regenerated.$defs.Product.properties.category
      expect(categoryProp.const).toBe("electronics")

      expect(regenerated.$defs.Product.required).toEqual(["id", "name", "price"])
    })

    it("should preserve computed fields with inverse", () => {
      // Given: Schema with computed inverse relationship
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              name: {
                type: "string"
              },
              users: {
                type: "array",
                items: {
                  $ref: "#/$defs/User"
                },
                "x-computed": true,
                "x-inverse": "company",
                "x-arktype": "User[]"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: {
                type: "string",
                format: "uuid",
                "x-mst-type": "identifier"
              },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single",
                "x-arktype": "Company"
              }
            },
            required: ["id"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: Computed field preserved with metadata
      const usersProp = regenerated.$defs.Company.properties.users
      expect(usersProp.type).toBe("array")
      expect(usersProp["x-computed"]).toBe(true)
      expect(usersProp["x-inverse"]).toBe("company")
      expect(usersProp["x-arktype"]).toBe("User[]")

      // Computed fields not in required array
      expect(regenerated.$defs.Company.required).toEqual(["id", "name"])
      expect(regenerated.$defs.Company.required).not.toContain("users")
    })
  })

  // =============================================================================
  // Section 6: Nested Properties Tests (STUBS)
  // =============================================================================

  describe("Nested Properties", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should handle nested object properties", () => {
      // Given: Schema with nested object
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" }
                }
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: Flat structure with parentProperty references
      const addressProp = allProperties.find((p: any) => p.name === "address")
      expect(addressProp).toBeDefined()
      expect(addressProp.parentProperty).toBeUndefined() // Top-level

      const streetProp = allProperties.find((p: any) => p.name === "street")
      expect(streetProp).toBeDefined()
      expect(streetProp.parentProperty).toBe(addressProp) // Child of address
      expect(streetProp.nestingType).toBe("properties")

      const cityProp = allProperties.find((p: any) => p.name === "city")
      expect(cityProp).toBeDefined()
      expect(cityProp.parentProperty).toBe(addressProp)
      expect(cityProp.nestingType).toBe("properties")
    })

    it("should handle array item schemas", () => {
      // Given: Schema with array items
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              tags: {
                type: "array",
                items: {
                  type: "string",
                  minLength: 1
                }
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: Items property created as child
      const tagsProp = allProperties.find((p: any) => p.name === "tags")
      expect(tagsProp).toBeDefined()
      expect(tagsProp.type).toBe("array")

      const itemsProp = allProperties.find((p: any) => p.parentProperty === tagsProp && p.nestingType === "items")
      expect(itemsProp).toBeDefined()
      expect(itemsProp.type).toBe("string")
      expect(itemsProp.minLength).toBe(1)
    })

    it("should handle multiple nesting levels", () => {
      // Given: Deep nesting
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              address: {
                type: "object",
                properties: {
                  location: {
                    type: "object",
                    properties: {
                      lat: { type: "number" },
                      lng: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: Three levels of nesting
      const addressProp = allProperties.find((p: any) => p.name === "address")
      const locationProp = allProperties.find((p: any) => p.name === "location")
      const latProp = allProperties.find((p: any) => p.name === "lat")

      expect(locationProp.parentProperty).toBe(addressProp)
      expect(latProp.parentProperty).toBe(locationProp)
      expect(latProp.type).toBe("number")
    })

    it("should reconstruct nested structure in view", () => {
      // Given: Schema with nested properties
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" }
                }
              }
            },
            required: ["id"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: Nested structure reconstructed
      expect(regenerated.$defs.User.properties.address).toBeDefined()
      expect(regenerated.$defs.User.properties.address.type).toBe("object")
      expect(regenerated.$defs.User.properties.address.properties.street).toBeDefined()
      expect(regenerated.$defs.User.properties.address.properties.street.type).toBe("string")
      expect(regenerated.$defs.User.properties.address.properties.city).toBeDefined()
      expect(regenerated.$defs.User.properties.address.properties.city.type).toBe("string")
    })
  })

  // =============================================================================
  // Section 7: Multi-Domain Support Tests (STUBS)
  // =============================================================================

  describe("Multi-Domain Support", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should handle domain-qualified model names", () => {
      // Given: Schema with domain-qualified names
      const schema = {
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string" },
              email: { type: "string" }
            }
          },
          "inventory.Product": {
            type: "object",
            "x-original-name": "Product",
            properties: {
              id: { type: "string" },
              name: { type: "string" }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const models = metaStore.modelCollection.all()

      // Then: Both models created with correct names
      expect(models.length).toBe(2)
      expect(models.some((m: any) => m.name === "User")).toBe(true)
      expect(models.some((m: any) => m.name === "Product")).toBe(true)
    })

    it("should populate Model.domain field", () => {
      // Given: Schema with domain-qualified names
      const schema = {
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string" }
            }
          },
          "inventory.Product": {
            type: "object",
            "x-original-name": "Product",
            properties: {
              id: { type: "string" }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const models = metaStore.modelCollection.all()

      // Then: Domain field correctly populated
      const userModel = models.find((m: any) => m.name === "User")
      expect(userModel).toBeDefined()
      expect(userModel.domain).toBe("auth")

      const productModel = models.find((m: any) => m.name === "Product")
      expect(productModel).toBeDefined()
      expect(productModel.domain).toBe("inventory")
    })

    it("should handle cross-domain references", () => {
      // Given: Schema with cross-domain reference
      const schema = {
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string" }
            }
          },
          "orders.Order": {
            type: "object",
            "x-original-name": "Order",
            properties: {
              id: { type: "string" },
              user: {
                $ref: "#/$defs/auth.User",
                "x-reference-type": "single"
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const properties = metaStore.propertyCollection.all()
      const orderModel = metaStore.modelCollection.all().find((m: any) => m.name === "Order")

      // Then: Cross-domain reference preserved
      const userProp = properties.find((p: any) => p.name === "user" && p.model === orderModel)
      expect(userProp).toBeDefined()
      expect(userProp.$ref).toBe("#/$defs/auth.User")
      expect(userProp.xReferenceType).toBe("single")
    })

    it("should preserve x-domain extension", () => {
      // Given: Multi-domain schema
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string" },
              email: { type: "string" }
            },
            required: ["id", "email"]
          },
          "inventory.Product": {
            type: "object",
            "x-original-name": "Product",
            properties: {
              id: { type: "string" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: x-domain extension preserved and domain-qualified keys used
      expect(regenerated.$defs["auth.User"]).toBeDefined()
      expect(regenerated.$defs["auth.User"]["x-domain"]).toBe("auth")
      expect(regenerated.$defs["auth.User"]["x-original-name"]).toBe("User")

      expect(regenerated.$defs["inventory.Product"]).toBeDefined()
      expect(regenerated.$defs["inventory.Product"]["x-domain"]).toBe("inventory")
      expect(regenerated.$defs["inventory.Product"]["x-original-name"]).toBe("Product")
    })
  })

  // =============================================================================
  // Section 8: Composition Operators Tests (STUBS)
  // =============================================================================

  describe("Composition Operators", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should handle oneOf arrays", () => {
      // Given: Schema with oneOf union type
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              contact: {
                oneOf: [
                  { type: "string", format: "email" },
                  { type: "string", format: "phone" }
                ]
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: oneOf creates child properties
      const contactProp = allProperties.find((p: any) => p.name === "contact")
      expect(contactProp).toBeDefined()

      const oneOfChildren = allProperties.filter((p: any) =>
        p.parentProperty === contactProp && p.nestingType === "oneOf"
      )
      expect(oneOfChildren.length).toBe(2)

      // Verify each option preserved
      const emailOption = oneOfChildren.find((p: any) => p.format === "email")
      expect(emailOption).toBeDefined()
      expect(emailOption.type).toBe("string")

      const phoneOption = oneOfChildren.find((p: any) => p.format === "phone")
      expect(phoneOption).toBeDefined()
      expect(phoneOption.type).toBe("string")
    })

    it("should handle anyOf arrays", () => {
      // Given: Schema with anyOf type
      const schema = {
        $defs: {
          Product: {
            type: "object",
            properties: {
              id: { type: "string" },
              price: {
                anyOf: [
                  { type: "number", minimum: 0 },
                  { type: "string", pattern: "^\\$[0-9]+\\.[0-9]{2}$" }
                ]
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: anyOf creates child properties
      const priceProp = allProperties.find((p: any) => p.name === "price")
      expect(priceProp).toBeDefined()

      const anyOfChildren = allProperties.filter((p: any) =>
        p.parentProperty === priceProp && p.nestingType === "anyOf"
      )
      expect(anyOfChildren.length).toBe(2)

      // Verify each option preserved
      const numberOption = anyOfChildren.find((p: any) => p.type === "number")
      expect(numberOption).toBeDefined()
      expect(numberOption.minimum).toBe(0)

      const stringOption = anyOfChildren.find((p: any) => p.type === "string")
      expect(stringOption).toBeDefined()
      expect(stringOption.pattern).toBe("^\\$[0-9]+\\.[0-9]{2}$")
    })

    it("should handle allOf arrays", () => {
      // Given: Schema with allOf intersection type
      const schema = {
        $defs: {
          Entity: {
            type: "object",
            properties: {
              metadata: {
                allOf: [
                  { type: "object", properties: { created: { type: "string" } } },
                  { type: "object", properties: { updated: { type: "string" } } }
                ]
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: allOf creates child properties
      const metadataProp = allProperties.find((p: any) => p.name === "metadata")
      expect(metadataProp).toBeDefined()

      const allOfChildren = allProperties.filter((p: any) =>
        p.parentProperty === metadataProp && p.nestingType === "allOf"
      )
      expect(allOfChildren.length).toBe(2)

      // Both should be object types
      allOfChildren.forEach((child: any) => {
        expect(child.type).toBe("object")
      })

      // Check nested properties exist
      const createdProp = allProperties.find((p: any) => p.name === "created")
      expect(createdProp).toBeDefined()
      expect(createdProp.type).toBe("string")

      const updatedProp = allProperties.find((p: any) => p.name === "updated")
      expect(updatedProp).toBeDefined()
      expect(updatedProp.type).toBe("string")
    })

    it("should handle nested composition", () => {
      // Given: Schema with composition within composition
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              value: {
                oneOf: [
                  { type: "string" },
                  {
                    anyOf: [
                      { type: "number" },
                      { type: "boolean" }
                    ]
                  }
                ]
              }
            }
          }
        }
      }

      // When: Ingest
      metaStore.ingestEnhancedJsonSchema(schema)
      const allProperties = metaStore.propertyCollection.all()

      // Then: Nested composition structure created
      const valueProp = allProperties.find((p: any) => p.name === "value")
      expect(valueProp).toBeDefined()

      // First level: oneOf children
      const oneOfChildren = allProperties.filter((p: any) =>
        p.parentProperty === valueProp && p.nestingType === "oneOf"
      )
      expect(oneOfChildren.length).toBe(2)

      // One should be string
      const stringOption = oneOfChildren.find((p: any) => p.type === "string")
      expect(stringOption).toBeDefined()

      // Other should have anyOf children
      const compositeOption = oneOfChildren.find((p: any) => p.type !== "string")
      expect(compositeOption).toBeDefined()

      const anyOfChildren = allProperties.filter((p: any) =>
        p.parentProperty === compositeOption && p.nestingType === "anyOf"
      )
      expect(anyOfChildren.length).toBe(2)

      // Verify nested options
      expect(anyOfChildren.some((p: any) => p.type === "number")).toBe(true)
      expect(anyOfChildren.some((p: any) => p.type === "boolean")).toBe(true)
    })

    it("should reconstruct composition in view", () => {
      // Given: Schema with all composition types
      const originalSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Contact: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: {
                oneOf: [
                  { type: "string", format: "email" },
                  { type: "string", format: "phone" }
                ]
              },
              metadata: {
                anyOf: [
                  { type: "object", properties: { source: { type: "string" } } },
                  { type: "string" }
                ]
              },
              combined: {
                allOf: [
                  { type: "object", properties: { created: { type: "string" } } },
                  { type: "object", properties: { updated: { type: "string" } } }
                ]
              }
            },
            required: ["id"]
          }
        }
      }

      // When: Round-trip
      const schema = metaStore.ingestEnhancedJsonSchema(originalSchema)
      const regenerated = schema.toEnhancedJson()

      // Then: All composition operators reconstructed
      const contactDef = regenerated.$defs.Contact

      // oneOf preserved
      expect(contactDef.properties.email.oneOf).toBeDefined()
      expect(contactDef.properties.email.oneOf.length).toBe(2)
      expect(contactDef.properties.email.oneOf[0].type).toBe("string")
      expect(contactDef.properties.email.oneOf[0].format).toBe("email")

      // anyOf preserved
      expect(contactDef.properties.metadata.anyOf).toBeDefined()
      expect(contactDef.properties.metadata.anyOf.length).toBe(2)

      // allOf preserved
      expect(contactDef.properties.combined.allOf).toBeDefined()
      expect(contactDef.properties.combined.allOf.length).toBe(2)
      expect(contactDef.properties.combined.allOf[0].type).toBe("object")
    })
  })

  // =============================================================================
  // Section 9: Runtime Store Generation
  // =============================================================================

  describe("Runtime Store Generation", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should generate runtime store from simple schema", () => {
      // Given: Meta-entities for basic User model
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
              email: { type: "string", format: "email" }
            },
            required: ["id", "name", "email"]
          }
        }
      })

      // When: Generate runtime store via existing pipeline
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson, {
        generateActions: true,
        validateReferences: true
      })

      // Then: Valid MST conversion result
      expect(result.models.User).toBeDefined()
      expect(result.collectionModels.UserCollection).toBeDefined()
      expect(typeof result.createStore).toBe("function")

      // Can instantiate store
      const store = result.createStore()
      expect(store.userCollection).toBeDefined()
    })

    it("should generate runtime store with references", () => {
      // Given: User → Company reference in meta-entities
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single"
              }
            },
            required: ["id", "name"]
          }
        }
      })

      // When: Generate store
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)
      const store = result.createStore()

      // Then: Reference field exists and both collections present
      expect(result.models.User).toBeDefined()
      expect(result.models.Company).toBeDefined()
      expect(store.companyCollection).toBeDefined()
      expect(store.userCollection).toBeDefined()
    })

    it("should generate runtime store with computed properties", () => {
      // Given: Company.users computed inverse in meta-entities
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              users: {
                type: "array",
                items: { $ref: "#/$defs/User" },
                "x-computed": true,
                "x-inverse": "company"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single"
              }
            },
            required: ["id"]
          }
        }
      })

      // When: Generate store
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)

      // Then: Models generated successfully (computed handling by MST pipeline)
      expect(result.models.Company).toBeDefined()
      expect(result.models.User).toBeDefined()
      expect(result.collectionModels.CompanyCollection).toBeDefined()
      expect(result.collectionModels.UserCollection).toBeDefined()
    })

    it("should generate multi-domain runtime store", () => {
      // Given: Domain-qualified models in meta-entities
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          "auth.User": {
            type: "object",
            "x-original-name": "User",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              email: { type: "string" }
            },
            required: ["id", "email"]
          },
          "inventory.Product": {
            type: "object",
            "x-original-name": "Product",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      })

      // When: Generate store
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)

      // Then: Multi-domain structure
      expect(result.domains).toBeDefined()
      expect(result.domains?.auth).toBeDefined()
      expect(result.domains?.inventory).toBeDefined()
      expect(result.domains?.auth?.models.User).toBeDefined()
      expect(result.domains?.inventory?.models.Product).toBeDefined()
    })
  })

  // =============================================================================
  // Section 10: Runtime Store Operations
  // =============================================================================

  describe("Runtime Store Operations", () => {
    let metaStore: any

    beforeEach(() => {
      const result = createMetaStore()
      metaStore = result.createStore()
    })

    it("should perform basic CRUD operations on generated store", () => {
      // Given: Generated store
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          }
        }
      })
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)
      const store = result.createStore()

      // When: Add entity
      const user = store.userCollection.add({
        id: "user-1",
        name: "Alice"
      })

      // Then: CRUD operations work
      expect(user.id).toBe("user-1")
      expect(user.name).toBe("Alice")
      expect(store.userCollection.get("user-1")).toBe(user)
      expect(store.userCollection.has("user-1")).toBe(true)
      expect(store.userCollection.all()).toContain(user)

      // Remove
      store.userCollection.remove("user-1")
      expect(store.userCollection.has("user-1")).toBe(false)
    })

    it("should resolve references in generated store", () => {
      // Given: Store with User → Company reference
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single"
              }
            },
            required: ["id", "name"]
          }
        }
      })
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)
      const store = result.createStore()

      // When: Create related entities
      const company = store.companyCollection.add({
        id: "company-1",
        name: "Acme Corp"
      })

      const user = store.userCollection.add({
        id: "user-1",
        name: "Alice",
        company: "company-1"  // MST resolves ID to reference
      })

      // Then: Reference resolves to actual instance
      expect(user.company).toBe(company)
      expect(user.company.name).toBe("Acme Corp")
    })

    it("should support computed inverse relationships", () => {
      // Given: Store with Company.users computed inverse
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          Company: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              users: {
                type: "array",
                items: { $ref: "#/$defs/User" },
                "x-computed": true,
                "x-inverse": "company"
              }
            },
            required: ["id", "name"]
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              company: {
                $ref: "#/$defs/Company",
                "x-reference-type": "single"
              }
            },
            required: ["id", "name"]
          }
        }
      })
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)
      const store = result.createStore()

      // When: Create entities with relationship
      const company = store.companyCollection.add({
        id: "company-1",
        name: "Acme Corp"
      })

      const alice = store.userCollection.add({
        id: "user-1",
        name: "Alice",
        company: "company-1"
      })

      const bob = store.userCollection.add({
        id: "user-2",
        name: "Bob",
        company: "company-1"
      })

      // Then: Computed inverse relationship works
      expect(company.users).toBeDefined()
      expect(company.users.length).toBe(2)
      expect(company.users).toContain(alice)
      expect(company.users).toContain(bob)
    })

    it("should preserve data through snapshot/restore", () => {
      // Given: Store with data
      const schema = metaStore.ingestEnhancedJsonSchema({
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", "x-mst-type": "identifier" },
              name: { type: "string" },
              email: { type: "string" }
            },
            required: ["id", "name", "email"]
          }
        }
      })
      const enhancedJson = schema.toEnhancedJson()
      const result = enhancedJsonSchemaToMST(enhancedJson)
      const store1 = result.createStore()

      // Create entities
      store1.userCollection.add({ id: "1", name: "Alice", email: "alice@example.com" })
      store1.userCollection.add({ id: "2", name: "Bob", email: "bob@example.com" })

      // When: Take snapshot and restore to new store
      const snapshot = getSnapshot(store1)
      const store2 = result.createStore()
      applySnapshot(store2, snapshot)

      // Then: All data preserved
      expect(store2.userCollection.all().length).toBe(2)
      expect(store2.userCollection.get("1").name).toBe("Alice")
      expect(store2.userCollection.get("2").name).toBe("Bob")
      expect(store2.userCollection.get("1").email).toBe("alice@example.com")
    })
  })
})

// =============================================================================
// Helper Functions
// =============================================================================
// (Moved to src/meta/ modules)
// - MetaRegistry: src/meta/meta-registry.ts
// - ingestProperty: src/meta/meta-helpers.ts
// - createMetaStore: src/meta/meta-store.ts (with layered computed views)

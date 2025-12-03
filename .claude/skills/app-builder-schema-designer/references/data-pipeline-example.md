# Data Pipeline Example

This is a **contrived, simplified example** demonstrating the transformation from discovery outputs to Enhanced JSON Schema for a data pipeline domain.

**Domain**: Customer data synchronization system

**Problem**: Customer data from a CRM needs to be synced to a data warehouse for analytics, with transformation and validation.

---

## Discovery Outputs (Layer 1)

### ProblemStatement

```
Description: "Need to sync customer records from CRM to data warehouse nightly. Records need validation and transformation before loading."

Pain Points:
- Manual CSV exports are error-prone
- No visibility into sync failures
- Transformation rules are scattered across scripts
- Can't retry failed records without re-running entire sync

Desired Outcome: "Automated pipeline that extracts customer data, validates and transforms it, loads to warehouse, and tracks success/failures per record."
```

### Analysis

```
Findings:
{
  "sourceSystem": "CRM API",
  "targetSystem": "DataWarehouse",
  "recordTypes": ["customer", "order"],
  "transformations": ["field_mapping", "data_type_conversion", "validation"],
  "syncFrequency": "nightly",
  "recordVolume": "10000-50000 per sync"
}

Complexity: medium

Complexity Rationale: "Medium complexity due to transformation logic, error handling per record, and need to track sync state. Not high because transformations are straightforward field mappings without complex business rules."
```

### Requirements (simplified)

**req-001**: Extract source records
- Description: "System must extract customer records from CRM API"
- Category: extraction
- Acceptance Criteria:
  - "Retrieves all customers modified since last sync"
  - "Captures source record ID and extraction timestamp"

**req-002**: Validate records
- Description: "System must validate required fields and data formats"
- Category: validation
- Acceptance Criteria:
  - "Checks required fields are present (email, name)"
  - "Validates email format"
  - "Records validation errors without failing entire sync"

**req-003**: Transform data
- Description: "System must map source fields to target schema"
- Category: transformation
- Acceptance Criteria:
  - "Maps CRM fields to warehouse column names"
  - "Converts data types (date strings to timestamps)"
  - "Records transformation applied"

**req-004**: Load to warehouse
- Description: "System must insert validated/transformed records to warehouse"
- Category: loading
- Acceptance Criteria:
  - "Successfully loaded records marked complete"
  - "Failed records can be retried"
  - "Tracks load timestamp"

### SolutionProposal

```
Phases:
1. Extraction Engine
   - Goal: Pull records from CRM API
   - Deliverables: Source connector, extraction tracking

2. Transformation Pipeline
   - Goal: Validate and transform records
   - Deliverables: Validation rules, field mapping, error handling

3. Loading Engine
   - Goal: Insert to data warehouse
   - Deliverables: Target connector, load tracking
```

---

## Transformation Process (Layer 1 → Layer 2)

### Phase 1: Context & Domain Understanding

**Nouns identified in requirements**:
- Source system (CRM) - mentioned in req-001
- Customer record - mentioned in req-001
- Validation error - mentioned in req-002
- Transformation - mentioned in req-003
- Target system (warehouse) - mentioned in req-004
- Sync run - implied by tracking requirements

**Domain inference**: Data pipeline with ETL (Extract, Transform, Load) workflow.

---

### Phase 2: Domain Model Design

#### Concept Categorization

**Entities** (independent lifecycle, have ID):

1. **SyncRun**
   - Why entity: Tracks overall sync execution, has lifecycle
   - Mentioned in: Implied by all requirements (need to track "per sync")
   - Lifecycle: Created when sync starts, completed when finishes

2. **SourceRecord**
   - Why entity: Represents customer data from CRM, tracked individually
   - Mentioned in: req-001, req-002, req-003, req-004
   - Lifecycle: Created on extraction, exists until archived

**Value Objects** (embedded, no ID):

1. **ValidationError** (part of SourceRecord)
   - Why value object: Only exists to describe issues with a specific record
   - No independent queries needed
   - Embedded array within SourceRecord

2. **FieldMapping** (part of TransformationConfig - could be separate entity)
   - Why value object: Configuration data, no lifecycle
   - Embedded within record processing

**Enums** (from findings and requirements):

1. **RecordType**: ["customer", "order"]
   - Source: analysis.findings.recordTypes

2. **ProcessingStatus**: ["extracted", "validated", "transformed", "loaded", "failed"]
   - Source: Inferred from workflow stages

3. **ValidationErrorType**: ["missing_required_field", "invalid_format", "data_type_mismatch"]
   - Source: req-002 acceptance criteria

#### Relationship Modeling

**SyncRun → SourceRecord** (1:N reference)
- Pattern: One sync run processes many records
- Cardinality: 1:N
- Schema: SourceRecord references SyncRun (SourceRecord.syncRun → SyncRun)

**SourceRecord → ValidationErrors** (1:N composition)
- Pattern: Record contains validation errors
- Cardinality: 1:N embedded
- Schema: Nested array within SourceRecord

#### Constraint Extraction

From **req-001** acceptance criteria:
- SourceRecord.sourceId: required (string, from CRM)
- SourceRecord.extractedAt: required (number timestamp)

From **req-002** acceptance criteria:
- Validation must check email, name fields
- ValidationError.field: required (which field failed)
- ValidationError.message: required (error description)

From **req-004** acceptance criteria:
- SourceRecord.status: required (tracks processing stage)
- SourceRecord.loadedAt: optional (only when successfully loaded)

#### Illustrative Model

```
SyncRun
├─ id: string (required)
├─ startedAt: number (required)
├─ completedAt: number (optional, only when finished)
├─ totalRecords: number (required)
├─ successCount: number (required, default 0)
└─ failureCount: number (required, default 0)

SourceRecord
├─ id: string (required)
├─ syncRun: → SyncRun (reference, required)
├─ sourceId: string (required, CRM record ID)
├─ recordType: enum ["customer", "order"] (required)
├─ status: enum ["extracted", "validated", "transformed", "loaded", "failed"] (required)
├─ extractedAt: number (required)
├─ validatedAt: number (optional)
├─ transformedAt: number (optional)
├─ loadedAt: number (optional)
├─ sourceData: object (required, raw CRM data)
├─ transformedData: object (optional, mapped data)
└─ validationErrors: ValidationError[] (embedded array)
   ├─ errorType: enum (required)
   ├─ field: string (required)
   └─ message: string (required)
```

---

### Phase 3: Schema Generation

```json
{
  "id": "xyz-456-abc",
  "name": "customer-data-sync",
  "format": "enhanced-json-schema",
  "createdAt": 1735520000000,
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "SyncRun": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "startedAt": {
          "type": "number"
        },
        "completedAt": {
          "type": "number"
        },
        "totalRecords": {
          "type": "number"
        },
        "successCount": {
          "type": "number"
        },
        "failureCount": {
          "type": "number"
        }
      },
      "required": ["id", "startedAt", "totalRecords", "successCount", "failureCount"],
      "x-original-name": "SyncRun"
    },
    "SourceRecord": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "syncRun": {
          "type": "string",
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "SyncRun"
        },
        "sourceId": {
          "type": "string"
        },
        "recordType": {
          "type": "string",
          "enum": ["customer", "order"]
        },
        "status": {
          "type": "string",
          "enum": ["extracted", "validated", "transformed", "loaded", "failed"]
        },
        "extractedAt": {
          "type": "number"
        },
        "validatedAt": {
          "type": "number"
        },
        "transformedAt": {
          "type": "number"
        },
        "loadedAt": {
          "type": "number"
        },
        "sourceData": {
          "type": "object"
        },
        "transformedData": {
          "type": "object"
        },
        "validationErrors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "errorType": {
                "type": "string",
                "enum": ["missing_required_field", "invalid_format", "data_type_mismatch"]
              },
              "field": {
                "type": "string"
              },
              "message": {
                "type": "string"
              }
            },
            "required": ["errorType", "field", "message"]
          }
        }
      },
      "required": ["id", "syncRun", "sourceId", "recordType", "status", "extractedAt", "sourceData"],
      "x-original-name": "SourceRecord"
    }
  }
}
```

---

## Key Patterns Demonstrated

### 1. Entity Identification (Different from Document Domain)

**SyncRun**: Tracks execution context (similar to ProcessingRun in doc domain)
**SourceRecord**: Individual data items being processed (different from Document)
**ValidationError**: Embedded diagnostic data (similar to Comment pattern)

**Pattern**: Even though domain is different, identification logic is same:
- What has independent lifecycle? → Entity
- What only exists within parent? → Value object

### 2. Workflow Status Tracking

**Document domain** had: "draft", "in_review", "approved", "rejected"
**Pipeline domain** has: "extracted", "validated", "transformed", "loaded", "failed"

**Pattern**: Status enums come from solution phases, not domain assumptions.

### 3. Progressive Timestamps

Similar to document domain, but different semantic meaning:
- **Document domain**: uploadedAt, assignedAt, decidedAt
- **Pipeline domain**: extractedAt, validatedAt, transformedAt, loadedAt

**Pattern**: Track temporal progression through workflow stages.

### 4. Flexible Data Structures

**sourceData** and **transformedData** are `type: "object"`:
- No predefined structure (varies by recordType)
- Allows domain flexibility without schema changes
- Similar to analysis.findings in discovery schema

**Pattern**: Use `type: "object"` for domain-specific flexible data.

### 5. Aggregation Fields

SyncRun tracks counts:
- totalRecords
- successCount
- failureCount

**Pattern**: Parent entities often track aggregate statistics about children.

---

## Validation (Phase 4)

```javascript
// Save schema
fs.writeFileSync(".schemas/customer-data-sync/schema.json", JSON.stringify(schema, null, 2))

// Register via Wavesmith
result = wavesmith.schema_set("customer-data-sync", schema)
// Returns: { ok: true, schemaId: "xyz-456-abc" }

// Load to test MST generation
load_result = wavesmith.schema_load("customer-data-sync")
// Returns: {
//   ok: true,
//   schemaId: "xyz-456-abc",
//   models: [
//     { name: "SyncRun", fields: ["id", "startedAt", ...] },
//     { name: "SourceRecord", fields: ["id", "syncRun", "sourceId", ...] }
//   ]
// }
```

**Success**: Schema compiles, generates SyncRun and SourceRecord models.

---

## Comparison to Document Domain

| Aspect | Document Domain | Data Pipeline Domain |
|--------|----------------|---------------------|
| **Core entities** | Document, Review | SyncRun, SourceRecord |
| **Workflow states** | draft→in_review→approved | extracted→validated→loaded |
| **Parent-child** | Document ← Review | SyncRun ← SourceRecord |
| **Embedded data** | Comment[] | ValidationError[] |
| **Temporal tracking** | uploadedAt, decidedAt | extractedAt, loadedAt |
| **Flexible structure** | N/A | sourceData, transformedData |

**Pattern**: Same transformation logic produces different schemas based on domain requirements.

---

## Summary

This example demonstrates:
- **Domain adaptation**: Same patterns, different entity names/relationships
- **Workflow modeling**: Status progression through pipeline stages
- **Flexible data**: Using `type: "object"` for domain-specific content
- **Aggregation tracking**: Parent entities with child statistics
- **Reference consistency**: SyncRun ← SourceRecord follows same pattern as Document ← Review

**The key**: The transformation logic doesn't "know" about data pipelines. It extracts patterns from requirements, producing domain-specific schemas regardless of whether it's documents, data, or any other domain.

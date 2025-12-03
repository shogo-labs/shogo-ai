# Transformation Patterns

This document provides **detailed algorithms** for transforming discovery outputs (requirements, analysis, solution phases) into Enhanced JSON Schemas.

**Core principle**: Every decision must trace back to discovery outputs. No domain assumptions.

---

## Table of Contents

1. [Entity Extraction](#1-entity-extraction)
2. [Entity vs Value Object Distinction](#2-entity-vs-value-object-distinction)
3. [Relationship Inference](#3-relationship-inference)
4. [Cardinality Determination](#4-cardinality-determination)
5. [Constraint Extraction](#5-constraint-extraction)
6. [Field Type Inference](#6-field-type-inference)
7. [Enum Detection](#7-enum-detection)
8. [Required vs Optional](#8-required-vs-optional)

---

## 1. Entity Extraction

**Goal**: Identify candidate entities from requirement descriptions.

### Algorithm

```
For each requirement in requirements:
  1. Extract nouns from requirement.description
  2. Extract nouns from requirement.acceptanceCriteria
  3. Check if mentioned in analysis.findings (confirms relevance)
  4. If mentioned multiple times → likely entity
  5. If only mentioned once → might be field or value object
```

### Noun Extraction Heuristic

**Simple approach**: Look for capitalized words or words preceded by "a/an/the"

**Example requirement**:
```
"System must track which reviewers are assigned to each document"
```

**Nouns found**:
- System (ignore - meta reference)
- reviewers → Reviewer (potential entity)
- document → Document (potential entity)

### Cross-Validation with Findings

Check analysis.findings for confirmation:

```javascript
analysis.findings = {
  "documentTypes": ["report", "proposal"],  // Confirms "document" is domain concept
  "reviewerRoles": ["technical", "legal"],  // Confirms "reviewer" is domain concept
  ...
}
```

**Decision**: Document and Reviewer are both domain concepts → likely entities.

### Multi-Requirement Frequency

Count noun occurrences across all requirements:

```
Document: mentioned in req-001, req-002, req-003, req-004 → 4 times
Review: mentioned in req-002, req-003, req-004 → 3 times
Comment: mentioned in req-003 → 1 time
```

**Pattern**: High frequency (3-4 mentions) → likely entity. Low frequency (1 mention) → likely field or value object.

---

## 2. Entity vs Value Object Distinction

**Goal**: Determine if a concept should be an entity (with ID, independent) or value object (embedded).

### Decision Tree

```
Is the concept mentioned in multiple requirements?
  NO → Likely value object or field
  YES → Continue...

Does it have independent lifecycle? (can it exist without a parent?)
  NO → Value object
  YES → Continue...

Would you query for it independently?
  NO → Value object
  YES → Entity

Does it have an "id" or similar identifier in findings?
  NO → Value object
  YES → Entity
```

### Examples

**Document** (entity):
- ✅ Mentioned in 4 requirements
- ✅ Independent lifecycle (exists after upload)
- ✅ Would query: "show me all documents"
- ✅ Has identifier

**Comment** (value object):
- ❌ Mentioned in 1 requirement
- ❌ No independent lifecycle (only exists within Review)
- ❌ Wouldn't query: "show me all comments" (would query "show me comments for review-123")
- ❌ No identifier mentioned

**Review** (entity):
- ✅ Mentioned in 3 requirements
- ✅ Independent lifecycle (tracks reviewer's work)
- ✅ Would query: "show me all reviews for document-123"
- ✅ Tracks state (pending → in_progress → completed)

### Key Questions

1. **"Can it exist without a parent?"**
   - Comment without Review? No → value object
   - Review without Document? Yes (for audit trail) → entity

2. **"Does it have workflow states?"**
   - If yes → likely entity (entities have lifecycle)

3. **"Would you create/update/delete it independently?"**
   - If yes → entity
   - If only modified as part of parent → value object

---

## 3. Relationship Inference

**Goal**: Identify how entities relate to each other.

### Verb Pattern Matching

Look for verbs in requirements that indicate relationships:

| Verb Pattern | Likely Relationship Type |
|--------------|--------------------------|
| "X processes Y" | X references Y |
| "X contains Y" | X embeds Y (composition) |
| "X generates Y" | X → Y (parent → child) |
| "X references Y" | X → Y (reference) |
| "X has many Y" | X → Y[] (1:N) |
| "Y belongs to X" | Y → X (N:1) |
| "X tracks Y" | X references Y |

### Example Analysis

**Requirement**: "System must track which reviewers are assigned to each document"

**Parsing**:
- Subject: reviewers
- Verb: "assigned to"
- Object: document

**Inference**: Reviewer → Document relationship (reviewer assigned to document)

**But also**: One document can have multiple reviewers → Document ← Reviewer[] (1:N)

### Composition vs Reference

**Composition** (embedded):
- Verb patterns: "contains", "includes", "has" (when child has no independent existence)
- Example: "Template contains sections" → sections embedded in Template

**Reference** (linked entities):
- Verb patterns: "processes", "references", "assigned to", "tracks"
- Example: "Review references document" → Review.document → Document

### Heuristic

```
If requirement says "X contains Y":
  Check if Y has independent lifecycle
    YES → Reference (X → Y)
    NO → Composition (X embeds Y)

If requirement says "X processes Y":
  Usually reference (X → Y)

If requirement says "X generates Y":
  Check solution phases for workflow
    If Y is output/result → Reference (X → Y)
```

---

## 4. Cardinality Determination

**Goal**: Determine if relationships are 1:1, 1:N, N:1, or N:M.

### Language Cues

| Phrase | Cardinality |
|--------|-------------|
| "a document" / "one document" | 1 (single) |
| "multiple documents" / "documents" (plural) | N (array) |
| "each reviewer" | 1 per reviewer |
| "all reviews" | N |
| "can be in multiple X" | N:M |

### Examples

**"Each review is for one document"**
- Review → Document: N:1 (many reviews, one document each)
- Schema: Review.document (single reference)

**"Each document can have multiple reviews"**
- Document ← Review: 1:N (one document, many reviews)
- Schema: Review.document → Document (single reference on Review side)

**"One recipe can be in multiple collections"**
- Recipe ↔ Collection: N:M
- Schema: Collection.recipes → Recipe[] (array reference)

### Decision Algorithm

```
For relationship X → Y:

1. Check requirement language:
   "X has a Y" → 1:1 or N:1
   "X has multiple Y" → 1:N
   "X has Y" (singular in description) → Likely 1:1
   "X has Y" (plural in description) → Likely 1:N

2. Check solution phases:
   If phase describes "for each X, process Y" → 1:N
   If phase describes "link X to Y" → 1:1 or N:M

3. Default heuristic:
   Parent → Child typically 1:N
   Child → Parent typically N:1
```

### Schema Translation

**1:1 or N:1** → Single reference:
```json
"document": {
  "type": "string",
  "x-mst-type": "reference",
  "x-reference-type": "single",
  "x-arktype": "Document"
}
```

**1:N or N:M** → Array reference:
```json
"reviews": {
  "type": "array",
  "items": { "type": "string" },
  "x-mst-type": "reference",
  "x-reference-type": "array",
  "x-arktype": "Review[]"
}
```

---

## 5. Constraint Extraction

**Goal**: Extract validation rules from acceptance criteria.

### Pattern Matching

| Acceptance Criteria Pattern | Constraint Type | Schema |
|------------------------------|----------------|--------|
| "Must be X or Y" | Enum | `enum: ["X", "Y"]` |
| "Required field: X" | Required | Add to `required` array |
| "Optional field: X" | Optional | Omit from `required` array |
| "At least N items" | Array min | `minItems: N` |
| "Maximum N items" | Array max | `maxItems: N` |
| "Between X and Y" | Numeric range | `minimum: X, maximum: Y` |
| "Valid email" | Format | `format: "email"` |
| "Timestamp" | Format hint | `type: "number"` |

### Examples

**Criterion**: "Decision must be 'approved' or 'rejected'"
- **Extract**: approved, rejected
- **Schema**: `"decision": { "type": "string", "enum": ["approved", "rejected"] }`

**Criterion**: "Captures required fields: title, type, timestamp"
- **Extract**: title, type, timestamp are required
- **Schema**: `"required": ["title", "type", "timestamp"]`

**Criterion**: "Recipe must have at least one ingredient"
- **Extract**: minimum 1 item
- **Schema**: `"ingredients": { "type": "array", "minItems": 1 }`

**Criterion**: "Confidence score between 0 and 1"
- **Extract**: numeric range 0-1
- **Schema**: `"confidence": { "type": "number", "minimum": 0, "maximum": 1 }`

### Algorithm

```
For each acceptance criterion in requirement.acceptanceCriteria:

  1. Look for "must be X or Y" pattern:
     Extract: ["X", "Y"]
     Apply: enum constraint

  2. Look for "required" keyword:
     Extract: field names
     Apply: add to required array

  3. Look for "at least N" or "minimum N":
     Extract: N
     Apply: minItems or minimum constraint

  4. Look for "between X and Y":
     Extract: X, Y
     Apply: minimum/maximum constraints

  5. Look for format keywords (email, URL, UUID):
     Extract: format type
     Apply: format constraint
```

---

## 6. Field Type Inference

**Goal**: Determine JSON Schema type for each field.

### Type Inference Rules

| Mentioned As | Inferred Type | Schema |
|--------------|---------------|--------|
| "title", "name", "description", "text" | String | `type: "string"` |
| "count", "score", "amount", "quantity" | Number | `type: "number"` |
| "timestamp", "date", "time", "createdAt" | Number (timestamp) | `type: "number"` |
| "isActive", "enabled", "flag" | Boolean | `type: "boolean"` |
| "list of X", "multiple X", "X array" | Array | `type: "array"` |
| "metadata", "data", "config" (flexible) | Object | `type: "object"` |
| "status", "type", "category" (limited options) | Enum | `type: "string", enum: [...]` |

### Context Clues

**From findings**:
```javascript
analysis.findings = {
  "totalSections": 81,        // Number
  "documentTypes": ["A", "B"], // Array/Enum
  "uploadedAt": 1735510000000 // Number (timestamp)
}
```

**From requirement descriptions**:
- "count" → number
- "timestamp when..." → number
- "list of..." → array
- "name" / "title" → string

### Special Cases

**Timestamps**: Always `type: "number"` (Unix timestamp in milliseconds)
```json
"createdAt": { "type": "number" }
```

**IDs**: Always `type: "string"` (even if UUID)
```json
"id": { "type": "string" }
```

**References**: `type: "string"` (ID) or `type: "array"` with `items: { type: "string" }`
```json
"document": {
  "type": "string",
  "x-mst-type": "reference"
}
```

---

## 7. Enum Detection

**Goal**: Identify fixed sets of values that should be enums.

### Sources

**1. From analysis.findings**:
```javascript
"findings": {
  "documentTypes": ["report", "proposal", "contract"],
  "reviewerRoles": ["technical", "manager", "legal"],
  "workflowStates": ["draft", "in_review", "approved"]
}
```

**Extract**: These are explicit enums in findings.

**2. From acceptance criteria**:
```
"Must be 'approved' or 'rejected'"
"Status can be 'pending', 'running', 'completed', or 'failed'"
```

**Extract**: Quoted values are enum options.

**3. From solution phases**:
```
Phases:
1. Draft → In Review → Approved/Rejected
```

**Extract**: Workflow stages become status enum.

### Validation

Before creating enum, verify:

1. **Limited set**: Are there < 20 values? (If unlimited, use string)
2. **Stable values**: Are these fixed options, or dynamic data?
3. **Descriptive**: Are values meaningful (not random IDs)?

**Good enum**:
```json
"status": {
  "type": "string",
  "enum": ["pending", "running", "completed", "failed"]
}
```

**Bad enum** (dynamic data):
```json
// WRONG - user names are not enum values
"reviewer": {
  "type": "string",
  "enum": ["Alice", "Bob", "Charlie"]  // These are data, not types!
}
```

### Algorithm

```
For each field that might be enum:

1. Check if mentioned in analysis.findings as array
   YES → Use as enum values

2. Check acceptance criteria for "must be X or Y"
   YES → Extract X, Y as enum values

3. Check if field name is "status", "type", "category", "priority"
   YES → Look for workflow states or type listings

4. Validate enum values:
   - Are they descriptive? (not IDs)
   - Are they stable? (not dynamic user data)
   - Limited set? (< 20 values)

5. If valid → Create enum
   If not → Use plain string type
```

---

## 8. Required vs Optional

**Goal**: Determine which fields must always be present.

### Heuristics

**Always required**:
- `id` (entity identifier)
- `createdAt` (creation timestamp)
- Fields mentioned as "required" in acceptance criteria
- Fields mentioned as "must capture/track/record"

**Often required**:
- Parent references (Review.document usually required)
- Workflow status fields (status, phase)
- Core identifying fields (name, title, type)

**Often optional**:
- Completion timestamps (completedAt - only when completed)
- Fields only present in certain states
- Descriptive fields (description, notes)
- Fields mentioned as "optional" in criteria

### Decision Algorithm

```
For each field:

1. Check if field is "id" or "createdAt"
   YES → Required

2. Check acceptance criteria for "required" or "must" keywords
   "Must capture X" → X is required
   "Optional X" → X is optional

3. Check if field only exists in certain states
   "completedAt only when status = completed" → Optional

4. Check if field is reference to parent/context
   Usually required (e.g., Review.document)

5. Default:
   Core fields (name, title, type, status) → Required
   Descriptive fields (description, notes) → Optional
```

### Examples

**Document entity**:
```json
"required": [
  "id",          // Always required
  "title",       // Core identifying field
  "type",        // Core categorization
  "uploadedBy",  // Must track (from criteria)
  "uploadedAt",  // Creation timestamp
  "status"       // Workflow tracking
]
// NOT required: "completedAt" (only when processing done)
```

**Review entity**:
```json
"required": [
  "id",          // Always required
  "document",    // Reference to parent (required)
  "reviewer",    // Must track who (from criteria)
  "assignedAt",  // Assignment timestamp
  "status"       // Workflow tracking
]
// NOT required: "decision" (only when review complete)
// NOT required: "decidedAt" (only when decision made)
```

---

## Cross-Pattern Example

Let's apply all patterns to one requirement:

**Requirement**: "System must track customer records from CRM with validation status and error messages"

### 1. Entity Extraction
- Nouns: "customer records", "validation status", "error messages"
- Candidates: CustomerRecord (entity), ValidationError (value object?)

### 2. Entity vs Value Object
- CustomerRecord: Independent lifecycle? YES → Entity
- ValidationError: Independent lifecycle? NO (only exists for a record) → Value object

### 3. Relationship
- CustomerRecord "has" ValidationError → Composition (embedded)

### 4. Cardinality
- "error messages" (plural) → 1:N → Array of ValidationError

### 5. Constraints
- "must track" → CustomerRecord fields are required
- "validation status" → Likely enum (pending, validated, failed)

### 6. Field Types
- "customer record" → Entity with id, fields
- "status" → String (enum)
- "error messages" → Array of objects

### 7. Enum Detection
- "validation status" → ["pending", "validated", "failed"]

### 8. Required vs Optional
- CustomerRecord.id → Required
- CustomerRecord.validationStatus → Required
- CustomerRecord.validationErrors → Optional (empty array when no errors)

### Result Schema

```json
"CustomerRecord": {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "validationStatus": {
      "type": "string",
      "enum": ["pending", "validated", "failed"]
    },
    "validationErrors": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "field": { "type": "string" },
          "message": { "type": "string" }
        },
        "required": ["field", "message"]
      }
    }
  },
  "required": ["id", "validationStatus"],
  "x-original-name": "CustomerRecord"
}
```

---

## Summary

**Transformation flow**:
1. Extract nouns → candidate entities
2. Apply entity/value object decision tree
3. Infer relationships from verbs
4. Determine cardinality from language
5. Extract constraints from criteria
6. Infer types from context
7. Detect enums from findings/criteria
8. Determine required vs optional

**Key principle**: Every decision traces to discovery outputs. No assumptions.

**When uncertain**: Present options to user and let them decide.

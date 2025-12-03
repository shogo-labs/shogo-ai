# Document Processing Example

This is a **contrived, simplified example** demonstrating the transformation from discovery outputs to Enhanced JSON Schema for a document processing domain.

**Domain**: Document approval workflow system

**Problem**: Documents need to be reviewed and approved by multiple reviewers, tracking comments and approval status.

---

## Discovery Outputs (Layer 1)

### ProblemStatement

```
Description: "Need a system to track document review and approval process. Documents get uploaded, assigned to reviewers, who can add comments and approve/reject."

Pain Points:
- Currently tracking approvals in spreadsheets
- Comments get lost in email threads
- Hard to see approval status at a glance
- No audit trail of who approved when

Desired Outcome: "Centralized system that tracks document lifecycle from upload through final approval, with all comments and decisions recorded."
```

### Analysis

```
Findings:
{
  "documentTypes": ["report", "proposal", "contract"],
  "workflowStates": ["draft", "in_review", "approved", "rejected"],
  "reviewerRoles": ["technical_reviewer", "manager", "legal"],
  "requiresApprovals": 2
}

Complexity: medium

Complexity Rationale: "Medium complexity due to multi-step workflow with reviewer assignments, comment tracking, and approval rules. No complex business logic or conditional processing."
```

### Requirements (simplified)

**req-001**: Extract document metadata
- Description: "System must capture document metadata including title, type, upload date, and uploader"
- Category: extraction
- Acceptance Criteria:
  - "Captures document title, type, and upload timestamp"
  - "Records who uploaded the document"

**req-002**: Track review assignments
- Description: "System must track which reviewers are assigned to each document"
- Category: workflow
- Acceptance Criteria:
  - "Can assign multiple reviewers to a document"
  - "Tracks assignment date for each reviewer"

**req-003**: Capture review comments
- Description: "Reviewers can add comments to documents during review"
- Category: collaboration
- Acceptance Criteria:
  - "Comments include text, author, and timestamp"
  - "Multiple comments can be added per review"

**req-004**: Track approval decisions
- Description: "System must record each reviewer's approval or rejection decision"
- Category: workflow
- Acceptance Criteria:
  - "Decision must be 'approved' or 'rejected'"
  - "Records timestamp of decision"
  - "Document approved when all reviewers approve"

### SolutionProposal

```
Phases:
1. Document Upload Handler
   - Goal: Accept document uploads and capture metadata
   - Deliverables: Document entity, metadata extraction

2. Review Workflow Engine
   - Goal: Manage reviewer assignments and track progress
   - Deliverables: Review entity, assignment logic, status tracking
```

---

## Transformation Process (Layer 1 → Layer 2)

### Phase 1: Context & Domain Understanding

**Nouns identified in requirements**:
- Document (mentioned in req-001, req-002, req-003, req-004)
- Reviewer (mentioned in req-002, req-003, req-004)
- Review (mentioned in req-002, req-003, req-004)
- Comment (mentioned in req-003)
- Decision (mentioned in req-004)

**Domain inference**: Document approval workflow system with reviewer assignments and status tracking.

---

### Phase 2: Domain Model Design

#### Concept Categorization

**Entities** (independent lifecycle, have ID):

1. **Document**
   - Why entity: Central concept, exists independently, can be queried
   - Mentioned in: All requirements
   - Lifecycle: Created on upload, exists until archived

2. **Review**
   - Why entity: Tracks individual reviewer's work, has status
   - Mentioned in: req-002, req-003, req-004
   - Lifecycle: Created when reviewer assigned, completed when decision made

**Value Objects** (embedded, no ID):

1. **Comment** (part of Review)
   - Why value object: Only exists within a review context
   - No independent queries needed
   - Lifetime bound to parent Review

2. **Metadata** (part of Document)
   - Why value object: Just data fields within Document
   - No independent existence needed

**Enums** (from findings):

1. **DocumentType**: ["report", "proposal", "contract"]
   - Source: analysis.findings.documentTypes

2. **ReviewStatus**: ["pending", "in_progress", "completed"]
   - Source: Inferred from workflow

3. **Decision**: ["approved", "rejected"]
   - Source: req-004 acceptance criteria

4. **WorkflowStatus**: ["draft", "in_review", "approved", "rejected"]
   - Source: analysis.findings.workflowStates

#### Relationship Modeling

**Document → Review** (1:N reference)
- Pattern: One document has many reviews
- Cardinality: 1:N (one document, multiple reviewers)
- Schema: Document doesn't store reviews directly (inverse relationship)
- Review references Document (Review.document → Document)

**Review → Comments** (1:N composition)
- Pattern: Review contains multiple comments
- Cardinality: 1:N embedded
- Schema: Nested array within Review entity

#### Constraint Extraction

From **req-001** acceptance criteria:
- Document.title: required (string)
- Document.type: required (enum from documentTypes)
- Document.uploadedAt: required (number timestamp)
- Document.uploadedBy: required (string)

From **req-004** acceptance criteria:
- Review.decision: required (enum: approved/rejected)
- Review.decidedAt: required when decision made (number timestamp)

From **req-003** acceptance criteria:
- Comment.text: required (string)
- Comment.author: required (string)
- Comment.timestamp: required (number)

#### Illustrative Model

```
Document
├─ id: string (required)
├─ title: string (required)
├─ type: enum ["report", "proposal", "contract"] (required)
├─ uploadedBy: string (required)
├─ uploadedAt: number (required)
└─ status: enum ["draft", "in_review", "approved", "rejected"] (required)

Review
├─ id: string (required)
├─ document: → Document (reference, required)
├─ reviewer: string (required)
├─ assignedAt: number (required)
├─ status: enum ["pending", "in_progress", "completed"] (required)
├─ decision: enum ["approved", "rejected"] (optional, only when completed)
├─ decidedAt: number (optional, only when completed)
└─ comments: Comment[] (embedded array)
   ├─ text: string (required)
   ├─ author: string (required)
   └─ timestamp: number (required)
```

---

### Phase 3: Schema Generation

```json
{
  "id": "abc-123-def",
  "name": "document-approval-system",
  "format": "enhanced-json-schema",
  "createdAt": 1735510000000,
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "Document": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "enum": ["report", "proposal", "contract"]
        },
        "uploadedBy": {
          "type": "string"
        },
        "uploadedAt": {
          "type": "number"
        },
        "status": {
          "type": "string",
          "enum": ["draft", "in_review", "approved", "rejected"]
        }
      },
      "required": ["id", "title", "type", "uploadedBy", "uploadedAt", "status"],
      "x-original-name": "Document"
    },
    "Review": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "document": {
          "type": "string",
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "Document"
        },
        "reviewer": {
          "type": "string"
        },
        "assignedAt": {
          "type": "number"
        },
        "status": {
          "type": "string",
          "enum": ["pending", "in_progress", "completed"]
        },
        "decision": {
          "type": "string",
          "enum": ["approved", "rejected"]
        },
        "decidedAt": {
          "type": "number"
        },
        "comments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "text": {
                "type": "string"
              },
              "author": {
                "type": "string"
              },
              "timestamp": {
                "type": "number"
              }
            },
            "required": ["text", "author", "timestamp"]
          }
        }
      },
      "required": ["id", "document", "reviewer", "assignedAt", "status"],
      "x-original-name": "Review"
    }
  }
}
```

---

## Key Patterns Demonstrated

### 1. Entity Identification

**Document**: Mentioned in all requirements → clearly an entity
**Review**: Tracks reviewer's work with state → entity (not just a field on Document)
**Comment**: Only exists within Review context → value object (embedded)

### 2. Reference vs Composition

**Reference** (Review → Document):
- Review.document uses `x-mst-type: "reference"`
- Review can exist after Document (for audit trail)
- Multiple Reviews reference same Document

**Composition** (Review → Comments):
- comments is nested array
- Comments have no independent existence
- Deleted when Review is deleted

### 3. Constraint Extraction

**From acceptance criteria**:
- "Must be 'approved' or 'rejected'" → `enum: ["approved", "rejected"]`
- "Captures title, type, timestamp" → All required fields
- "Multiple comments can be added" → Array type for comments

**From findings**:
- `documentTypes: ["report", "proposal", "contract"]` → Document.type enum
- `workflowStates: [...]` → Document.status enum

### 4. Required vs Optional

**Required**: Fields mentioned in "must capture" acceptance criteria
- Document.id, title, type, uploadedBy, uploadedAt, status
- Review.id, document, reviewer, assignedAt, status

**Optional**: Fields that only exist in certain states
- Review.decision (only when completed)
- Review.decidedAt (only when decision made)

### 5. Temporal Tracking

All entities track time:
- Document.uploadedAt (creation time)
- Review.assignedAt (when review started)
- Review.decidedAt (when decision made)
- Comment.timestamp (when comment added)

Pattern: Use `type: "number"` for Unix timestamps (Date.now())

---

## Validation (Phase 4)

```javascript
// Save schema
fs.writeFileSync(".schemas/document-approval-system/schema.json", JSON.stringify(schema, null, 2))

// Register via Wavesmith
result = wavesmith.schema_set("document-approval-system", schema)
// Returns: { ok: true, schemaId: "abc-123-def" }

// Load to test MST generation
load_result = wavesmith.schema_load("document-approval-system")
// Returns: {
//   ok: true,
//   schemaId: "abc-123-def",
//   models: [
//     { name: "Document", fields: ["id", "title", "type", ...] },
//     { name: "Review", fields: ["id", "document", "reviewer", ...] }
//   ]
// }
```

**Success**: Schema compiles without errors, generates Document and Review models.

---

## Anti-Patterns to Avoid

### ❌ Assuming Structure

**Wrong**: "All document systems need Page, Section, Paragraph entities"

**Right**: This domain only needs Document and Review based on requirements.

### ❌ Over-Engineering

**Wrong**: Creating separate entities for Comment, Decision, Assignment

**Right**: Comments are value objects (embedded). Decision is just an enum field.

### ❌ Missing References

**Wrong**: `"document": { "type": "string" }` (no x-mst-type)

**Right**: Add `x-mst-type: "reference"` so Wavesmith generates correct relationship.

### ❌ Generic Names

**Wrong**: Using "Item", "Record", "Object" as entity names

**Right**: Use domain language: "Document", "Review" from requirements.

---

## Summary

This example demonstrates:
- **Entity identification**: Central concepts with independent lifecycle
- **Value object distinction**: Embedded data with no independent existence
- **Reference modeling**: Using x-mst-type for relationships
- **Constraint extraction**: Enums and required fields from criteria
- **Domain specificity**: Names come from requirements, not assumptions

**The key**: Every decision traces back to discovery outputs. No assumptions about document processing "standards" - only what this specific domain requires.

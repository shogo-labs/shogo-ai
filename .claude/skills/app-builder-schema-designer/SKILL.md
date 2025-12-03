---
name: app-builder-schema-designer
description: Transform app-builder discovery specifications into Enhanced JSON Schemas for Wavesmith state management. This skill should be used after discovery is complete to generate domain-specific schemas that define entities, relationships, and constraints based on requirements and analysis findings. Works across domains (document processing, data pipelines, web apps, automation workflows) by extracting entity patterns from discovery outputs rather than assuming domain-specific structures.
---

# App Builder Schema Designer

## Overview

This skill bridges the gap between **discovery specifications** (Layer 1: requirements, analysis, solution design) and **runtime implementation** (Layer 3: executable code). It produces **Enhanced JSON Schemas** (Layer 2) that define domain models in a format that Wavesmith can transform into reactive state management systems.

**Core Philosophy**: Domain modeling first, tooling second. Think about entities, relationships, and constraints - then express them in Enhanced JSON Schema format. Wavesmith is the persistence layer, not the focus.

**When to use this skill**:
- After app-builder-discovery has completed and been approved
- When you have validated requirements with acceptance criteria
- When you need to create a schema for a new application domain
- When transforming human-readable specs into machine-executable models

**What this skill does NOT do**:
- Generate implementation code (that's Layer 3: build_types.py, code generators)
- Make assumptions about domain structure (always evidence-based from discovery)
- Copy existing schemas as templates (each domain is unique)

## Project Workspace Integration

This skill integrates with AppBuilderProject workspace orchestration:

**Before starting schema design**:
1. Load app-builder-project schema
2. Find project by discoverySessionId or workspacePath
3. Get workspace paths from project entity
4. Switch to app-builder-discovery schema for session work
5. Use workspace parameter when registering schemas

**Schema storage location**:
- User schemas: `{workspacePath}/.wavesmith/schemas/{schema-name}/`
- NOT in wavesmith-state-api repository

**Project linking**:
- After schema creation, update project.domainSchemaId
- Enables implementation-spec skill to find the schema

### Working with Multiple Schemas

This skill manages two schemas during execution:
- **app-builder-project**: Project workspace and orchestration
- **app-builder-discovery**: Discovery session and entities

**Schema switching pattern**:

```javascript
// When you need project data (workspace paths, IDs):
wavesmith.schema_load("app-builder-project")
project = wavesmith.store_get("AppBuilderProject", project_id)
// ... work with project ...

// When you need discovery data (sessions, requirements):
wavesmith.schema_load("app-builder-discovery")
session = wavesmith.store_get("DiscoverySession", session_id)
// ... work with discovery ...
```

**Important**: Always ensure you're in the correct schema before create/update/get/list operations.

**Common workflow**:
1. Load app-builder-project → Get workspace paths
2. Switch to app-builder-discovery → Load discovery session
3. Work with discovery data (most of skill execution)
4. Switch to app-builder-project → Update project.domainSchemaId
5. Switch back to app-builder-discovery → Update session

## Getting Started

### Load the Discovery Schema

Before working with discovery data, load the schema:

```javascript
// Load app-builder-discovery schema
wavesmith.schema_load("app-builder-discovery")

// This makes discovery entities queryable via MCP tools
```

### Understand the Discovery Structure

Discovery outputs consist of several entity types:

- **DiscoverySession**: Root entity tracking the overall discovery process
- **ProblemStatement**: The problem being solved (pain points, desired outcome)
- **Artifact**: Files uploaded during discovery (templates, examples, designs)
- **Analysis**: Findings from artifact analysis (complexity, patterns, domain context)
- **Requirement**: Derived requirements with acceptance criteria
- **SolutionProposal**: Proposed implementation phases

See `references/discovery-schema-structure.md` for complete documentation.

### Finding the Discovery Workspace

Discovery sessions create workspaces following this pattern:
`{wavesmith-state-api}/.schemas/app-builder-discovery/workspaces/{session-name}/`

**To locate it**:
1. Check `DiscoverySession.workspacePath` (if available in loaded data)
2. Or construct: Find wavesmith-state-api location + append path above

**What workspaces contain**:
- Uploaded artifacts from discovery
- Analysis outputs (structure varies by domain)
- Environment setup (if needed for analysis)

## The 8-Phase Workflow

This skill follows a **conversational, collaborative workflow** with review gates where they make sense. Be flexible - users may want to iterate or skip ahead if they have strong opinions about the model design.

### Phase Overview

1. **Context & Domain Understanding** - Load discovery outputs and understand the domain
2. **Domain Model Design** - Design entities, relationships, and constraints
3. **Schema Generation** - Translate conceptual model to Enhanced JSON Schema
4. **Requirements Coverage Check** (NEW) - Verify schema supports all requirements
5. **Schema Extension Pass** (NEW) - Autonomously fill coverage gaps
6. **Error & Edge Case Modeling** (NEW) - Add failure states and quality indicators
7. **Coverage Report Generation** (NEW) - Document 100% coverage or explicit gaps
8. **Validation & Registration** - Register with Wavesmith and validate MST generation

### Phase 1: Context & Domain Understanding

**Goal**: Load discovery outputs and understand what domain we're modeling.

**Process**:

1. **Load project context and get workspace paths**:

   a. Load app-builder-project schema:
   ```javascript
   wavesmith.schema_load("app-builder-project")
   ```

   b. Find project by workspace (or ask user for discoverySessionId):
   ```javascript
   // Option 1: Find by current workspace
   workspace_path = process.cwd()
   projects = wavesmith.store_list("AppBuilderProject", {
     filter: { workspacePath: workspace_path }
   })

   // Option 2: If user provides discoverySessionId
   // projects = wavesmith.store_list("AppBuilderProject", {
   //   filter: { discoverySessionId: provided_session_id }
   // })

   if (projects.length === 0) {
     console.log("ERROR: No AppBuilderProject found. Run app-builder-discovery first.")
     return
   }

   project = projects[0]
   ```

   c. Get workspace paths from project:
   ```javascript
   workspace_root = project.workspacePath  // Absolute path
   schema_dir = workspace_root + "/" + project.schemaDir  // e.g., ".wavesmith/schemas"
   discovery_dir = workspace_root + "/" + project.discoveryDir  // e.g., ".wavesmith/discovery"
   ```

   d. Switch to discovery schema:
   ```javascript
   wavesmith.schema_load("app-builder-discovery")
   ```

   e. Get discovery session from project:
   ```javascript
   session_id = project.discoverySessionId

   if (!session_id) {
     console.log("ERROR: Project has no linked discovery session.")
     console.log("Run app-builder-discovery skill to create session first.")
     return
   }
   ```

2. **Load discovery entities** via Wavesmith MCP:
   ```javascript
   // Get session
   session = wavesmith.store_get("DiscoverySession", session_id)

   // Get problem statement
   problem = wavesmith.store_get("ProblemStatement", session.problemStatement)

   // Get analysis
   analysis = wavesmith.store_get("Analysis", session.analysis)

   // Get all requirements for this session
   all_requirements = wavesmith.store_list("Requirement")
   requirements = all_requirements.filter(r => r.derivedFrom === session.analysis)

   // Get solution proposal
   solution = wavesmith.store_get("SolutionProposal", session.solutionProposal)
   ```

3. **Present domain summary**:
   ```
   "I've loaded the discovery session: **{session.name}**

   Problem: {problem.description}

   Domain: {inferred from analysis.findings}
   Complexity: {analysis.complexity}
   Requirements: {requirements.length} requirements identified

   Key entities mentioned: [list nouns from requirements]

   Ready to design the domain model?"
   ```

4. **Ask clarifying questions** if domain is unclear:
   - "This looks like a document processing system. Is that correct?"
   - "Should the schema model the parsing workflow, or just the data structures?"
   - "Are there any entities I should definitely include or exclude?"

### Understanding Discovery Outputs

**SolutionProposal.phases**: High-level implementation goals
- Example: "Document Structure Parser", "Template Comparison Engine"

**Your schema entities**: Data model supporting those goals
- Example: Template, Contract, ComparisonRun, UpdateRun

**The relationship**:
- Solution phases = WHAT will be built (features)
- Schema entities = STATE during execution (data)

Your schema should **enable** the solution phases, not mirror them 1:1.

**Transition criteria**: User confirms understanding and is ready to proceed.

---

### Phase 2: Domain Model Design

**Goal**: Design the complete domain model - entities, value objects, relationships, and constraints.

**Process**:

### Understanding the Discovery Workspace

The workspace contains artifacts and analysis from discovery. Use these to inform your schema design.

**Workspace location** (from AppBuilderProject, loaded in Phase 1):
```javascript
// Already loaded in Phase 1
workspace_root = project.workspacePath  // e.g., "/Users/ryan/odin-dev-stack"
discovery_dir = workspace_root + "/" + project.discoveryDir  // e.g., ".wavesmith/discovery"
schema_dir = workspace_root + "/" + project.schemaDir  // e.g., ".wavesmith/schemas"
```

**Exploration approach**:
1. List workspace contents to understand structure:
   ```bash
   ls {discovery_dir}/artifacts/
   ```
2. Check DiscoverySession.artifacts for what was analyzed
3. Look for analysis outputs that reveal domain structure:
   ```bash
   ls {discovery_dir}/temp_analysis/
   ```
4. Use existing analysis rather than re-analyzing from scratch

**Integration with discovery data**:
- Analysis.findings describes WHAT was found
- Workspace artifacts show HOW it was found (evidence)
- Use both together to inform entity extraction

**Working within the workspace**:
- Perform analysis in discovery_dir (not /tmp or other locations)
- Preserve analysis outputs unless user requests cleanup
- Leverage any existing environments or tools

1. **Extract concepts** from requirements:
   - Nouns in requirement descriptions → potential entities
   - Objects in analysis.findings → data structures
   - States in solution phases → enums or lifecycle tracking

### Workspace Artifact Exploration (Autonomous Enrichment)

**IMPORTANT**: Before presenting your initial conceptual model to the user, check if the discovery workspace contains artifacts that could inform entity design.

**Trigger conditions**:
1. You have loaded discovery session successfully
2. Discovery session has artifacts (check Analysis.findings for mentions of files)
3. You are about to present initial conceptual model

**Autonomous exploration steps**:

```bash
# Check if workspace exists and has artifacts
# Use discovery_dir from project (already loaded in Phase 1)
ls {discovery_dir}/artifacts/

# If temp_analysis/ exists, files were analyzed during discovery
ls {discovery_dir}/temp_analysis/
```

**What to look for**:
- Extracted content (XML, JSON, CSV, etc.) revealing data structures
- Analysis scripts showing what discovery examined
- Example files showing domain patterns

**Integration approach**:
- Explore workspace BEFORE presenting initial model
- Extract domain-specific patterns (enums, property structures, nested objects)
- Incorporate findings directly into initial model presentation
- This produces richer, more accurate schemas from the start

**Example**: If you find a configuration file with a list of valid status codes, include those as an enum in your initial entity model rather than adding them in a later iteration.

**Why this matters**: Workspace exploration can lead to significantly richer schemas. Doing this BEFORE first presentation eliminates iteration cycles.

2. **Categorize concepts**:

   **Entities** (have identity, independent lifecycle, can be queried):
   - Criteria: Has `id` field, mentioned in multiple requirements, can exist independently
   - Example: Template, Contract, ProcessingRun, User, DataSource

   **Value Objects** (embedded within entities, no independent existence):
   - Criteria: Only exists within parent, no `id` needed, inline data structure
   - Example: Section (part of Template), Address (part of User), Credentials (part of DataSource)

   **Enums** (fixed set of options):
   - Criteria: Limited set of values found in analysis.findings or solution phases
   - Example: Status values, Priority levels, Section types

3. **Model relationships**:

   **Composition** (parent owns child, lifetime bound):
   - Pattern: Parent entity contains child value objects
   - Schema: Nested `type: "object"` or `type: "array", items: {...}`
   - Example: Template.sections[], User.address

   **Reference** (independent entities linked):
   - Pattern: Entity references another entity by ID
   - Schema: `x-mst-type: "reference"` with `x-reference-type: "single"` or `"array"`
   - Example: ProcessingRun → Template, User → posts[]

   **Cardinality**:
   - 1:1 → Single reference: `x-reference-type: "single"`
   - 1:N → Array reference: `x-reference-type: "array"`
   - N:M → Array reference on both sides

4. **Extract constraints** from acceptance criteria:

   **Required fields**:
   - Pattern: "Must identify...", "All X must have..."
   - Schema: Add to `required: [...]` array

   **Enums**:
   - Pattern: "Must be X or Y", Limited set in findings
   - Schema: `enum: ["X", "Y", "Z"]`

   **Type constraints**:
   - Pattern: "Score between 0 and 1", "Must be valid email"
   - Schema: `type: "number", minimum: 0, maximum: 1` or `type: "string", format: "email"`

   **Array constraints**:
   - Pattern: "At least N items", "Maximum N items"
   - Schema: `minItems: N`, `maxItems: N`

5. **Present illustrative model**:

   Show the conceptual model before jumping to JSON. Options:

   **Option A: ASCII diagram**
   ```
   Template
   ├─ id: string (required)
   ├─ filename: string (required)
   ├─ sections: Section[] (embedded)
   │  ├─ sectionName: string
   │  ├─ content: string
   │  └─ pwStyle: enum (PWSectionDefault, PWSectionMandatory, ...)
   └─ status: enum (draft, active, archived)

   ProcessingRun
   ├─ id: string (required)
   ├─ template: → Template (reference)
   ├─ contract: → Contract (reference)
   ├─ status: enum (pending, running, completed, failed)
   └─ results: MatchResult[] (embedded)
   ```

   **Option B: Structured outline**
   ```
   Entities:
   1. Template
      - Has identity (id field)
      - Contains sections (embedded value objects)
      - Referenced by ProcessingRun

   2. ProcessingRun
      - Has identity (id field)
      - References Template and Contract
      - Tracks execution status
      - Contains results (embedded)

   Value Objects:
   1. Section (part of Template)
      - No id field (lifetime bound to Template)
      - Has properties: sectionName, content, pwStyle

   Enums:
   1. ProcessingStatus: ["pending", "running", "completed", "failed"]
   2. PWStyle: ["PWSectionDefault", "PWSectionMandatory", ...]
   ```

   **Option C: Prose description**
   ```
   The domain model centers around Templates and Contracts. Templates represent reusable contract structures with conditional sections controlled by PracticeWorks style markers. Each template contains an embedded collection of sections (value objects).

   When processing occurs, a ProcessingRun entity is created that references both a Template and a Contract. The run tracks execution status and contains embedded MatchResults showing how well sections matched.
   ```

6. **Review gate - Request approval**:
   ```
   "Does this domain model capture the structure correctly?

   - Are the entities identified correctly?
   - Should any value objects be promoted to entities (or vice versa)?
   - Are the relationships clear?
   - Any constraints I'm missing?

   Let me know if you'd like me to adjust anything before generating the schema."
   ```

### Iterating on the Domain Model

**Iteration checkpoint - Before re-presenting model:**

Ask yourself: "Is this the FIRST time I'm presenting the conceptual model?"

**If YES** (first presentation):
- Show complete conceptual model with ASCII diagram or outline
- Include all entities, relationships, and constraints
- Present full picture for user understanding

**If NO** (subsequent iterations):
- **SHOW ONLY WHAT CHANGED** using diff format
- Do NOT re-present the entire model
- User can request full view if needed: "show me the full model"

**Delta format example**:
```diff
Changes based on your feedback:

EntityA:
- Removed: RelatedEntityB (simplified per your suggestion)
+ Added: configurationSettings[] (discovered from workspace artifacts)
+ Added: validationRules (from analysis findings)

NestedObject (within EntityA):
- Removed: calculatedField1, calculatedField2 (not needed)
+ Added: statusType enum with values (from domain analysis)
```

**When to show full model again:**
- User explicitly requests: "show me the full model"
- Major restructure (3+ entities changed significantly)
- After 3+ iterations (user may have lost context)

**Anti-pattern**: Do NOT present the same complete model multiple times in a row. This forces unnecessary scrolling and reduces clarity.

**Transition criteria**: User confirms model design or requests adjustments. Iterate until approved.

---

### Phase 3: Schema Generation

**Goal**: Translate the conceptual model into a valid Enhanced JSON Schema.

**Process**:

1. **Initialize schema structure**:
   ```javascript
   {
     "id": generateUniqueId(),  // UUID
     "name": session.name,      // kebab-case from discovery
     "format": "enhanced-json-schema",
     "createdAt": Date.now(),
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$defs": {}
   }
   ```

2. **Generate entity definitions** (one per entity identified in Phase 2):
   ```javascript
   "$defs": {
     "EntityName": {
       "type": "object",
       "properties": {
         // Fields defined below
       },
       "required": [...],  // Required fields
       "x-original-name": "EntityName"
     }
   }
   ```

3. **Generate fields** for each entity:

   **Simple fields**:
   ```javascript
   "fieldName": {
     "type": "string" | "number" | "boolean",
     "format": "date-time" | "email" | "uuid" | ...,  // Optional
     "minimum": 0,    // For numbers
     "maximum": 100,  // For numbers
   }
   ```

   **Enum fields**:
   ```javascript
   "status": {
     "type": "string",
     "enum": ["pending", "running", "completed", "failed"]
   }
   ```

   **Nested objects** (value objects):
   ```javascript
   "address": {
     "type": "object",
     "properties": {
       "street": { "type": "string" },
       "city": { "type": "string" },
       "zipCode": { "type": "string" }
     },
     "required": ["street", "city", "zipCode"]
   }
   ```

   **Nested arrays** (embedded collections):
   ```javascript
   "sections": {
     "type": "array",
     "items": {
       "type": "object",
       "properties": {
         "sectionName": { "type": "string" },
         "content": { "type": "string" }
       },
       "required": ["sectionName", "content"]
     }
   }
   ```

   **Single reference** (1:1 or N:1):
   ```javascript
   "template": {
     "type": "string",  // Stored as ID
     "x-mst-type": "reference",
     "x-reference-type": "single",
     "x-arktype": "Template"  // Target entity name
   }
   ```

   **Array reference** (1:N or N:M):
   ```javascript
   "artifacts": {
     "type": "array",
     "items": { "type": "string" },  // Array of IDs
     "x-mst-type": "reference",
     "x-reference-type": "array",
     "x-arktype": "Artifact[]"
   }
   ```

   **Temporal tracking** (timestamps):
   ```javascript
   "createdAt": { "type": "number" },     // Date.now()
   "updatedAt": { "type": "number" },
   "analyzedAt": { "type": "number" }
   ```

4. **Add required fields array**:
   ```javascript
   "required": ["id", "name", "createdAt", ...]
   ```

   **Heuristic**: At minimum, `id` and `createdAt` are usually required for entities.

5. **Present generated schema** with explanation:
   ```
   "Here's the generated Enhanced JSON Schema:

   📦 Entities: {count}
   🔗 Relationships: {count}
   ✅ Constraints: {count enums, count required fields}

   Key patterns used:
   - Template → ProcessingRun: Single reference (1:N)
   - Template → sections[]: Nested array (composition)
   - ProcessingRun.status: Enum from analysis findings
   - Section.pwStyle: Enum from detected patterns

   The schema includes:
   - All entities identified in Phase 2
   - References using x-mst-type extensions
   - Constraints from acceptance criteria
   - Temporal tracking fields

   [Show key excerpts or full schema]

   Would you like me to adjust anything before we validate?"
   ```

6. **Review gate - Request approval**:
   ```
   "Does the schema look correct? Common adjustments:
   - Change field types (string → number, etc.)
   - Add/remove required fields
   - Adjust enum values
   - Change relationship types (reference ↔ embedded)

   Let me know if you'd like changes, or we can proceed to validation."
   ```

**Transition criteria**: User approves schema or requests changes. Iterate until approved.

**Next phase**: requirements_coverage_check

---

### Phase 4: Requirements Coverage Check

**Goal**: Systematically verify that the schema supports ALL discovery requirements. Identify gaps before finalizing.

**Process**:

#### 1. Load Discovery Requirements

Retrieve all requirements from Wavesmith for this session:

```javascript
// Get session and analysis
session = wavesmith.store_get("DiscoverySession", session_id)
analysis = wavesmith.store_get("Analysis", session.analysis)

// Get all requirements derived from this analysis
all_requirements = wavesmith.store_list("Requirement")
relevant_reqs = all_requirements.filter(r => r.derivedFrom === session.analysis)

console.log(`Requirements to map: ${relevant_reqs.length}`)
```

#### 2. Create Coverage Mapping

For each requirement, identify which schema elements support it:

**Mapping criteria:**
- **Entity**: Does a top-level entity track this concept?
- **Field**: Does a field store required data?
- **Relationship**: Does a reference link related concepts?
- **Constraint**: Does an enum, validation rule, or required field enforce this?

**Example mappings (domain-agnostic):**

| Discovery Requirement | Schema Element(s) | Coverage Status |
|-----------------------|-------------------|-----------------|
| req-001: Track primary items | ItemEntity.id, ItemEntity.name | ✅ Full |
| req-002: Link related entities | ItemEntity.relatedItems → RelatedEntity | ✅ Full |
| req-003: Validate item completeness | ItemEntity.validationStatus enum | ✅ Full |
| req-004: Store processing metadata | ProcessingRun.metadata object | ✅ Full |
| req-005: Detect missing items | ??? NO SCHEMA SUPPORT | ❌ Gap |
| req-006: Track quality indicators | ??? PARTIAL - no quality score field | ⚠️ Partial |

#### 3. Categorize Coverage

Count requirements by status:

```javascript
coverage_analysis = {
  "full": [],      // Requirement fully satisfied by schema
  "partial": [],   // Requirement partially satisfied (some aspects missing)
  "missing": []    // Requirement not addressed at all
}

// For each requirement, analyze schema and categorize
relevant_reqs.forEach(req => {
  let status = analyze_coverage(req, schema)
  coverage_analysis[status].push({
    id: req.id,
    description: req.description,
    missing_aspects: get_missing_aspects(req, schema)
  })
})

console.log(`Full: ${coverage_analysis.full.length}`)
console.log(`Partial: ${coverage_analysis.partial.length}`)
console.log(`Missing: ${coverage_analysis.missing.length}`)
```

#### 4. Present Gap Summary

Show user which requirements lack schema support:

**Format:**

```
📊 Requirements Coverage Analysis

✅ Full Coverage: 4/7 requirements (57%)
⚠️ Partial Coverage: 2/7 requirements (29%)
❌ Missing Coverage: 1/7 requirements (14%)

Gaps requiring schema extension:

1. req-005 "Detect missing items"
   - Missing: No field to store detected gaps
   - Suggested: Add detectedGaps field to ProcessingRun OR create MissingItem entity

2. req-006 "Track quality indicators"
   - Partial: Has boolean validation flag but no quality score
   - Suggested: Add qualityScore field (0-1 range) to ItemEntity

Proceeding to Schema Extension Pass...
```

**Anti-patterns to avoid:**

❌ "Requirement not satisfied" → Too vague, no actionable guidance
❌ Assuming coverage without checking each requirement individually
❌ Mapping to implementation details (functions) instead of schema elements
✅ Specific gap identification with suggested extensions

**Transition criteria**: Coverage analysis complete with gaps identified

**Next phase**: schema_extension_pass

---

### Phase 5: Schema Extension Pass

**Goal**: Autonomously extend the schema to achieve 100% requirements coverage. Fill gaps identified in Phase 4.

**Process**:

#### 1. Review Gaps from Phase 4

For each gap (partial or missing coverage), decide extension strategy:

**Decision Framework:**

| Gap Type | Extension Strategy | When to Use |
|----------|-------------------|-------------|
| **New Entity** | Create independent entity with id, lifecycle | Gap represents a distinct concept with independent existence |
| **New Field** | Add field to existing entity | Gap is metadata/attribute of existing concept |
| **New Enum** | Add enum with fixed values | Gap represents state/status with limited options |
| **New Relationship** | Add reference (single or array) | Gap represents connection between existing entities |
| **New Constraint** | Add validation rule, required field | Gap represents data quality requirement |

#### 2. Implement Extensions

For each gap, implement the extension and document rationale:

**Example 1: Missing Item Detection (New Field)**

```javascript
// Gap: req-005 "Detect missing items"
// Analysis: Missing items are metadata about processing run, not independent entities
// Decision: Add field to ProcessingRun entity

// Update schema $defs
schema.$defs.ProcessingRun.properties.detectedGaps = {
  "type": "array",
  "items": { "type": "string" },
  "description": "Identifiers of expected items that were not found during processing (e.g., ['item-003', 'item-007'])"
}

// Optional: Add to required if critical
// schema.$defs.ProcessingRun.required.push("detectedGaps")

// Document extension
extension_log.push({
  requirement: "req-005",
  strategy: "new_field",
  target: "ProcessingRun.detectedGaps",
  rationale: "Missing items are processing metadata, not entities with independent lifecycle"
})
```

**Example 2: Quality Indicators (New Field with Constraint)**

```javascript
// Gap: req-006 "Track quality indicators"
// Analysis: Quality is attribute of individual items
// Decision: Add quality score field with validation constraints

schema.$defs.ItemEntity.properties.qualityScore = {
  "type": "number",
  "minimum": 0.0,
  "maximum": 1.0,
  "description": "Quality indicator score (0=poor, 1=excellent)"
}

extension_log.push({
  requirement: "req-006",
  strategy: "new_field_with_constraint",
  target: "ItemEntity.qualityScore",
  rationale: "Quality is numeric attribute with defined range, not categorical state"
})
```

**Example 3: Review Workflow (New Entity + Enum)**

```javascript
// Gap: req-007 "Support human review workflow"
// Analysis: Review is complex process with state, history, actors
// Decision: Create ReviewRecord entity + ReviewStatus enum

schema.$defs.ReviewStatus = {
  "type": "string",
  "enum": ["pending_review", "in_review", "approved", "rejected"],
  "description": "Status of human review process"
}

schema.$defs.ReviewRecord = {
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "targetItem": {
      "type": "string",
      "x-mst-type": "reference",
      "x-reference-type": "single",
      "x-arktype": "ItemEntity"
    },
    "status": { "$ref": "#/$defs/ReviewStatus" },
    "reviewerNotes": { "type": "string" },
    "reviewedBy": { "type": "string" },
    "reviewedAt": { "type": "number" },
    "createdAt": { "type": "number" }
  },
  "required": ["id", "targetItem", "status", "createdAt"],
  "x-original-name": "ReviewRecord"
}

extension_log.push({
  requirement: "req-007",
  strategy: "new_entity_with_enum",
  target: "ReviewRecord entity + ReviewStatus enum",
  rationale: "Review involves multiple actors, state transitions, and temporal tracking - warrants dedicated entity"
})
```

**Example 4: Relationship Extension (Array Reference)**

```javascript
// Gap: req-008 "Track dependencies between items"
// Analysis: Items reference other items in many-to-many relationship
// Decision: Add array reference to existing entity

schema.$defs.ItemEntity.properties.dependencies = {
  "type": "array",
  "items": { "type": "string" },
  "x-mst-type": "reference",
  "x-reference-type": "array",
  "x-arktype": "ItemEntity[]",
  "description": "Items that this item depends on for processing"
}

extension_log.push({
  requirement: "req-008",
  strategy: "new_relationship",
  target: "ItemEntity.dependencies",
  rationale: "Dependency tracking requires entity references, not just storing IDs as strings"
})
```

#### 3. Update Schema Structure

Apply all extensions to the schema object:

```javascript
// Pseudocode - actual implementation depends on schema structure
relevant_reqs.filter(r => coverage_analysis.partial.includes(r) || coverage_analysis.missing.includes(r))
  .forEach(req => {
    extension = decide_extension_strategy(req, schema)
    apply_extension(schema, extension)
    extension_log.push({
      requirement: req.id,
      strategy: extension.type,
      target: extension.path,
      rationale: extension.rationale
    })
  })
```

#### 4. Present Extension Summary

Show user what was added:

**Format:**

```
🔧 Schema Extensions Applied

Extended schema to achieve 100% requirements coverage:

1. ✅ req-005 "Detect missing items"
   - Added: ProcessingRun.detectedGaps (array of strings)
   - Rationale: Missing items are processing metadata, not independent entities

2. ✅ req-006 "Track quality indicators"
   - Added: ItemEntity.qualityScore (number, 0-1 range)
   - Rationale: Quality is numeric attribute with validation constraints

3. ✅ req-007 "Support human review workflow"
   - Added: ReviewRecord entity + ReviewStatus enum
   - Rationale: Complex workflow with state, actors, and history

Total Extensions: 3 new fields, 1 new entity, 1 new enum

Updated schema now covers 7/7 requirements (100%)
```

**Anti-patterns to avoid:**

❌ Over-engineering (creating entity when field suffices)
❌ Domain-specific examples (OCR quality, PDF parsing, etc.)
❌ Silent extensions (must document rationale)
✅ Right-sized solutions (field vs entity decision framework)
✅ Generic patterns applicable to any domain

**Transition criteria**: All partial/missing gaps from Phase 4 addressed with extensions applied and documented

**Next phase**: error_edge_case_modeling

---

### Phase 6: Error & Edge Case Modeling

**Goal**: Model failure modes and data quality concerns for primary entities. Ensure schema supports not just "happy path" but error handling and edge cases.

**Process**:

#### 1. Identify Primary Entities

Primary entities are those with:
- Independent lifecycle (have `id` field)
- Referenced by other entities
- Central to core functionality

```javascript
// Extract primary entities from schema
primary_entities = Object.keys(schema.$defs).filter(name => {
  entity = schema.$defs[name]
  return entity.properties && entity.properties.id && entity.required.includes("id")
})

console.log(`Primary entities: ${primary_entities.join(", ")}`)
```

#### 2. Systematic Error Probing

For each primary entity, apply structured probing:

**Probing Categories:**

| Category | Probe Questions | Field Examples |
|----------|----------------|----------------|
| **Validation Status** | Can creation/processing fail? What validation errors occur? | `validationErrors: string[]`, `validationStatus: enum` |
| **Quality Indicators** | What quality concerns exist? How measure completeness/correctness? | `qualityScore: number`, `completenessPercentage: number` |
| **Processing Failures** | Can operations on this entity fail? How track failures? | `processingStatus: enum`, `errorMessage: string`, `failureReason: enum` |
| **Data Integrity** | Can relationships be broken? Can references be invalid? | `hasValidReferences: boolean`, `brokenReferences: string[]` |
| **Temporal Concerns** | Can entities become stale/expired? Are there lifecycle limits? | `expiresAt: number`, `lastValidatedAt: number`, `isStale: boolean` |

#### 3. Add Error Modeling Fields

For each concern identified, add appropriate fields:

**Example 1: Validation Status (Enum + Error List)**

```javascript
// For ItemEntity: Processing may fail validation
schema.$defs.ValidationStatus = {
  "type": "string",
  "enum": ["not_validated", "valid", "invalid", "partially_valid"],
  "description": "Validation state of entity"
}

schema.$defs.ItemEntity.properties.validationStatus = {
  "$ref": "#/$defs/ValidationStatus"
}

schema.$defs.ItemEntity.properties.validationErrors = {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "field": { "type": "string" },
      "message": { "type": "string" },
      "severity": { "type": "string", "enum": ["error", "warning", "info"] }
    },
    "required": ["field", "message", "severity"]
  },
  "description": "List of validation errors encountered"
}
```

**Example 2: Quality Indicators (Numeric Scores)**

```javascript
// For ProcessingRun: Track success rate and completeness
schema.$defs.ProcessingRun.properties.successRate = {
  "type": "number",
  "minimum": 0.0,
  "maximum": 1.0,
  "description": "Proportion of items successfully processed (0-1 range)"
}

schema.$defs.ProcessingRun.properties.itemsProcessed = {
  "type": "number",
  "minimum": 0,
  "description": "Count of items successfully processed"
}

schema.$defs.ProcessingRun.properties.itemsFailed = {
  "type": "number",
  "minimum": 0,
  "description": "Count of items that failed processing"
}
```

**Example 3: Processing Failures (Status + Error Message)**

```javascript
// For ItemEntity: Track processing outcome
schema.$defs.ProcessingStatus = {
  "type": "string",
  "enum": ["pending", "processing", "completed", "failed", "retrying"],
  "description": "Current processing state"
}

schema.$defs.ItemEntity.properties.processingStatus = {
  "$ref": "#/$defs/ProcessingStatus"
}

schema.$defs.ItemEntity.properties.errorMessage = {
  "type": "string",
  "description": "Error message if processing failed"
}

schema.$defs.ItemEntity.properties.retryCount = {
  "type": "number",
  "minimum": 0,
  "description": "Number of processing retry attempts"
}
```

**Example 4: Reference Integrity (Broken Reference Tracking)**

```javascript
// For entities with references: Track broken relationships
schema.$defs.ItemEntity.properties.hasValidReferences = {
  "type": "boolean",
  "description": "Whether all referenced entities exist and are valid"
}

schema.$defs.ItemEntity.properties.brokenReferences = {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "field": { "type": "string" },
      "targetId": { "type": "string" },
      "reason": { "type": "string" }
    }
  },
  "description": "List of references that could not be resolved"
}
```

#### 4. Balance Completeness with Pragmatism

**Guidelines:**

- **Add error modeling for critical paths** (core entities, high-risk operations)
- **Skip error modeling for simple value objects** (embedded objects with no lifecycle)
- **Use enums for known failure modes** (defined set of outcomes)
- **Use strings for unpredictable errors** (exception messages, stack traces)
- **Make error fields optional** (they're only populated on failure)

**Anti-patterns:**

❌ Adding error fields to every entity (over-engineering)
❌ Creating Error entity for everything (unnecessary indirection)
❌ Mixing error tracking with business logic fields
✅ Error fields on processing/workflow entities
✅ Quality indicators on data entities
✅ Optional error fields (not required)

#### 5. Present Error Modeling Summary

Show user what error handling was added:

**Format:**

```
🛡️ Error & Edge Case Modeling Applied

Added failure mode tracking to 3 primary entities:

1. ItemEntity:
   - validationStatus (enum: not_validated, valid, invalid, partially_valid)
   - validationErrors (array of structured error objects)
   - processingStatus (enum: pending, processing, completed, failed, retrying)
   - errorMessage (string)
   - qualityScore (number, 0-1)

2. ProcessingRun:
   - successRate (number, 0-1)
   - itemsProcessed, itemsFailed (counts)
   - detectedGaps (from Phase 5)

3. ReviewRecord:
   - (Already has status tracking from Phase 5)

Entities now support:
✅ Validation error tracking
✅ Processing failure states
✅ Quality measurement
✅ Retry logic support
```

**Transition criteria**: Error and edge case modeling complete for primary entities

**Next phase**: coverage_report_generation

---

### Phase 7: Coverage Report Generation

**Goal**: Create formal documentation showing that schema covers 100% of discovery requirements (or explicitly documents remaining gaps with justification).

**Process**:

#### 1. Build Final Coverage Mapping

Regenerate coverage analysis incorporating extensions from Phases 5-6:

```javascript
// Reload requirements and create final mapping
final_coverage = relevant_reqs.map(req => {
  schema_elements = find_schema_support(req, schema)
  status = schema_elements.length > 0 ? "satisfied" : "gap"

  return {
    id: req.id,
    description: req.description,
    priority: req.priority,
    schema_elements: schema_elements,
    status: status,
    added_in_phase: schema_elements.some(e => extension_log.find(ext => ext.target === e)) ? "extension" : "initial"
  }
})

// Count by status
satisfied = final_coverage.filter(r => r.status === "satisfied").length
gaps = final_coverage.filter(r => r.status === "gap").length
coverage_percent = (satisfied / relevant_reqs.length * 100).toFixed(1)
```

#### 2. Generate Coverage Report

Create structured report documenting requirement-to-schema traceability:

**Format:**

```markdown
## Requirements Coverage Report

**Session**: {session.name}
**Schema**: {schema.name}
**Generated**: {timestamp}

### Summary

- **Total Requirements**: {relevant_reqs.length}
- **Satisfied**: {satisfied} ({coverage_percent}%)
- **Gaps Remaining**: {gaps}
- **Entities Created**: {Object.keys(schema.$defs).length}
- **Extensions Applied**: {extension_log.length}

### Detailed Mapping

| Requirement | Priority | Schema Element(s) | Status | Notes |
|-------------|----------|-------------------|--------|-------|
| req-001: Track primary items | Critical | ItemEntity.id, ItemEntity.name | ✅ Satisfied | Initial model |
| req-002: Link related entities | High | ItemEntity.relatedItems → RelatedEntity | ✅ Satisfied | Initial model |
| req-003: Validate completeness | High | ItemEntity.validationStatus, validationErrors | ✅ Satisfied | Added in Phase 6 |
| req-004: Store metadata | Medium | ProcessingRun.metadata | ✅ Satisfied | Initial model |
| req-005: Detect missing items | High | ProcessingRun.detectedGaps | ✅ Satisfied | Added in Phase 5 |
| req-006: Track quality | Medium | ItemEntity.qualityScore | ✅ Satisfied | Added in Phase 5 |
| req-007: Human review workflow | High | ReviewRecord entity, ReviewStatus enum | ✅ Satisfied | Added in Phase 5 |

### Extensions Summary

**Phase 5 (Schema Extension Pass):**
- ProcessingRun.detectedGaps (array) - Missing item detection
- ItemEntity.qualityScore (number) - Quality indicators
- ReviewRecord entity + ReviewStatus enum - Review workflow

**Phase 6 (Error & Edge Case Modeling):**
- ValidationStatus enum + ItemEntity.validationStatus
- ItemEntity.validationErrors (array of error objects)
- ProcessingStatus enum + ItemEntity.processingStatus
- ProcessingRun.successRate, itemsProcessed, itemsFailed

### Gaps Remaining

{if gaps === 0}
**No gaps remaining** - All requirements fully supported by schema.

{else}
The following requirements are not fully satisfied:

| Requirement | Gap Reason | Mitigation |
|-------------|------------|------------|
| req-XXX: Description | Explanation of why not in schema | How this will be addressed (deferred, out of scope, etc.) |

{endif}

### Verification

Schema supports:
- ✅ All core functionality requirements (req-001 through req-004)
- ✅ Edge case requirements from discovery (req-005 through req-007)
- ✅ Error handling and validation tracking
- ✅ Quality measurement and monitoring
- ✅ Processing failure modes

**Recommendation**: Schema is ready for Implementation Spec phase.
```

#### 3. Store Coverage Report

Save report to workspace or as schema metadata:

```javascript
// Option 1: Write to workspace file
workspace_path = session.workspacePath
report_path = workspace_path + "/schema-coverage-report.md"
// Write report content to file

// Option 2: Store in Wavesmith (if schema metadata supported)
// schema.metadata.coverageReport = report_content

// Option 3: Create separate CoverageReport entity (if needed)
coverage_report_id = wavesmith.store_create("CoverageReport", {
  id: "cov-" + generateUniqueId(),
  schemaId: schema.id,
  totalRequirements: relevant_reqs.length,
  satisfied: satisfied,
  coveragePercentage: coverage_percent,
  reportContent: report_content,
  generatedAt: Date.now()
})
```

#### 4. Present Coverage Summary to User

```
📊 Requirements Coverage Report Generated

Schema Coverage: {coverage_percent}%
- Satisfied: {satisfied}/{relevant_reqs.length} requirements
- Gaps Remaining: {gaps}

Extensions Applied:
- Phase 5: {count} schema elements added
- Phase 6: {count} error handling fields added

{if coverage_percent === 100}
✅ Complete coverage achieved! Schema supports all discovery requirements.
{else}
⚠️ {gaps} requirements not fully satisfied (see report for details)
{endif}

Report saved to: {workspace_path}/schema-coverage-report.md

Ready to proceed to Validation & Registration (Phase 8).
```

**Transition criteria**: Coverage report generated and 100% coverage achieved (or gaps explicitly documented with justification)

**Next phase**: validation_registration

---

### Phase 8: Validation & Registration

**Goal**: Register schema with Wavesmith and validate MST generation works.

**Process**:

1. **Register schema directly via Wavesmith MCP**:

**ALWAYS use Wavesmith MCP for schema registration. DO NOT use filesystem operations.**

```javascript
// 1. Switch to app-builder-project schema to get workspace path
wavesmith.schema_load("app-builder-project")
projects = wavesmith.store_list("AppBuilderProject", {
  filter: { discoverySessionId: session_id }
})
project = projects[0]

// 2. Construct workspace parameter
workspace_path = project.workspacePath + "/" + project.schemaDir

// 3. Register schema with workspace parameter (Wavesmith handles persistence)
// CRITICAL: User schemas must be saved to project workspace, not wavesmith repo
result = wavesmith.schema_set({
  name: session.name,
  format: "enhanced-json-schema",
  payload: schema_payload,
  workspace: workspace_path  // Saves to project, not .schemas/
})

if (!result.ok) {
  // Handle registration error (see Phase 4 recovery below)
}

console.log(`✅ Schema registered with ID: ${result.schemaId}`)
console.log(`📦 Schema location: ${workspace_path}/${session.name}/`)

// 4. Switch back to discovery schema for session updates
wavesmith.schema_load("app-builder-discovery")
```

**DO NOT:**
- Use `mkdir -p` to create .schemas/ directories
- Use `fs.writeFileSync` to save schema.json files
- Manually create or modify files in .schemas/

**Why MCP-first:**
- Wavesmith MCP handles persistence, validation, and ID assignment automatically
- Filesystem writes can cause permissions issues or path confusion
- MCP ensures schema is immediately available for loading

2. **Load schema to validate MST generation**:
   ```javascript
   load_result = wavesmith.schema_load(session.name)

   if (!load_result.ok) {
     // Handle load error (Phase 8 recovery below)
   }

   console.log(`Schema loaded successfully`)
   console.log(`Models generated: ${load_result.models.map(m => m.name).join(", ")}`)
   ```

3. **Link schema to project**:
   ```javascript
   // Switch to app-builder-project schema
   wavesmith.schema_load("app-builder-project")

   // Update project with domainSchemaId
   wavesmith.store_update("AppBuilderProject", project.id, {
     "domainSchemaId": session.name,  // Schema name (not UUID!)
     "lastUpdatedAt": Date.now()
   })

   console.log(`✅ Project updated with domain schema: ${session.name}`)

   // Switch back to discovery schema
   wavesmith.schema_load("app-builder-discovery")
   ```

4. **Reference coverage report from Phase 7**:

After schema validates successfully, reference the comprehensive coverage report:

```
✅ Schema validated and registered successfully!

📄 Schema: {workspace_path}/{session.name}/schema.json
🆔 Schema ID: {schemaId}
📦 Models: {model names}
🔗 Project: {project.name} (domainSchemaId updated)

📊 Requirements Coverage: {coverage_percent}% ({satisfied}/{total})
📋 Full Coverage Report: {workspace_path}/schema-coverage-report.md

The schema supports:
- {satisfied} requirements (see Phase 7 report for detailed mapping)
- Error handling for {count} primary entities
- Quality tracking for {count} entities
- Validation status for {count} entities

The schema is now ready for implementation. You can:
- Create entity instances via store.create
- Query data via store.list / store.get
- Generate Pydantic models via build_types.py (if using Python)

Next steps: Use app-builder-implementation-spec skill to create interfaces and algorithms.
```

**Transition criteria**: Schema validates successfully, or errors are resolved.

---

### Phase 8 Recovery: Error Handling

When validation fails, follow this pattern:

1. **Diagnose the error**:
   - Parse error message from Wavesmith
   - Identify error type (undefined reference, invalid format, missing required field, etc.)

2. **Explain the issue** to user:
   ```
   "Schema loading failed with error: {error message}

   Diagnosis: {plain language explanation}

   Likely cause: {specific issue in the schema}
   ```

3. **Propose fix**:
   ```
   "I can fix this by: {specific change}

   For example:
   - Add missing entity definition to $defs
   - Fix reference target name (ProcessingRun vs processingRun)
   - Add required 'id' field to entity
   - Correct x-mst-type spelling

   Should I apply this fix and retry?"
   ```

4. **Apply fix** (if user approves):
   - Update schema object
   - Save updated schema to disk
   - Re-register via schema.set
   - Retry schema.load

5. **Iterate until success** or user intervention:
   ```
   "Retrying with updated schema...

   ✅ Success! The issue is resolved.

   [Continue to success report]"
   ```

**Common errors and fixes**:

| Error | Cause | Fix |
|-------|-------|-----|
| "Reference to undefined entity 'X'" | Entity referenced but not in $defs | Add X entity definition |
| "Invalid x-mst-type value" | Typo or wrong extension name | Correct to "reference" or "identifier" |
| "Missing required field 'id'" | Entity definition missing id | Add id field with type: "string" |
| "Invalid reference target" | x-arktype points to non-existent entity | Fix entity name in x-arktype |
| "Duplicate entity name" | Same entity in $defs twice | Remove duplicate |

---

## Conversational Patterns

### Tone and Style

- **Collaborative, not prescriptive**: "Does this look right?" not "This is what we're doing"
- **Evidence-based**: "Requirement req-003 mentions templates, so I'm creating a Template entity"
- **Iterative**: Expect multiple rounds of refinement
- **Visual when helpful**: Use diagrams, outlines, or structured representations

### Question Patterns

**Phase 1 (Understanding)**:
- "Which discovery session should I use?"
- "This looks like a {domain} system. Is that correct?"
- "Should the schema model {aspect A} or {aspect B}?"

**Phase 2 (Model Design)**:
- "I see {nouns} mentioned in requirements. Should these be entities or value objects?"
- "Should {entity A} reference {entity B}, or embed it?"
- "Are there any entities I'm missing or misclassifying?"

**Phase 3 (Schema Generation)**:
- "Should {field} be required or optional?"
- "I found {values} in the findings. Should this be an enum?"
- "Would you like me to adjust anything before we validate?"

**Phase 4 (Coverage Check)**:
- "I found {N} requirements not covered by schema. Proceeding to extension pass."
- "Schema coverage: {percent}%. Gaps identified: {list}"

**Phase 5 (Schema Extension)**:
- "Should {entity} be a new entity or field on existing entity?"
- "For requirement {req-ID}, I'm adding {extension} because {rationale}. Does this make sense?"

**Phase 6 (Error Modeling)**:
- "Should we add error tracking to {entity}?"
- "This entity handles {workflow}, so I'm adding status tracking."

**Phase 7 (Coverage Report)**:
- "Schema now covers {percent}% of requirements."
- "Coverage report generated. Would you like to review it before validation?"

**Phase 8 (Validation)**:
- "Schema loading failed. Should I apply the fix and retry?"
- "The error suggests {issue}. Does this sound right?"

### Approval Requests

**End of Phase 2**:
```
"Does this domain model capture the structure correctly? Let me know if you'd like me to adjust anything before generating the schema."
```

**End of Phase 3**:
```
"Does the schema look correct? Let me know if you'd like changes, or we can proceed to validation."
```

**After error fix**:
```
"I've identified the issue and have a proposed fix. Should I apply this and retry?"
```

---

## Domain Adaptation

This skill works across domains by **extracting patterns from discovery outputs** rather than assuming domain-specific structures.

### How it Adapts

**Document Processing Domain**:
- Entities: Template, Contract, Section, Rule
- Relationships: Template → sections[], ProcessingRun → Template
- Constraints: PW style enums from findings

**Data Pipeline Domain**:
- Entities: SourceSystem, DataObject, TransformationRun, LoadResult
- Relationships: SourceSystem → DataObject[], TransformationRun → LoadResult[]
- Constraints: Sync status enums, data type validation

**Web Application Domain**:
- Entities: Component, Category, Example, SearchIndex
- Relationships: Category → Component[], Component → Example[]
- Constraints: Component type enums, required props

**Pattern**: The skill doesn't know these entity names ahead of time. It discovers them from requirements.

### Generic Transformation Logic

**Entity extraction**:
1. Find nouns in requirement descriptions
2. Check if mentioned in analysis.findings (confirms relevance)
3. Determine if it has independent lifecycle (entity) or not (value object)

**Relationship inference**:
1. Look for verbs like "processes", "contains", "generates", "references"
2. Check solution phases for workflow descriptions
3. Determine cardinality from language ("a template" vs "multiple templates")

**Constraint extraction**:
1. Parse acceptance criteria for "must", "required", "should be"
2. Identify options from "X or Y" patterns
3. Look for numeric constraints ("between 0 and 1", "at least 3")

See `references/transformation-patterns.md` for detailed algorithms.

---

## Common Pitfalls

### Pitfall 1: Copying Existing Schemas

**Wrong**: "This is similar to KPMG, so I'll use that schema as a template"

**Right**: "KPMG had Template and Contract entities. Let me check if this domain mentions similar concepts in the requirements."

**Why**: Every domain is unique. KPMG patterns don't apply to data pipelines.

### Pitfall 2: Assuming Entity Names

**Wrong**: "All document systems have 'Document' and 'Page' entities"

**Right**: "Requirements mention 'templates' and 'contracts', so I'll use Template and Contract"

**Why**: Entity names come from the domain language, not generic assumptions.

### Pitfall 3: Over-Engineering

**Wrong**: "I'll create entities for every noun in the requirements"

**Right**: "Only nouns with independent lifecycle become entities. Others are value objects or just fields."

**Why**: Too many entities creates unnecessary complexity.

### Pitfall 4: Missing References

**Wrong**: `"template": { "type": "string" }` (just a string field)

**Right**: `"template": { "type": "string", "x-mst-type": "reference", "x-reference-type": "single" }`

**Why**: Wavesmith needs the x-mst-* extensions to generate correct relationships.

### Pitfall 5: Skipping Validation

**Wrong**: "The schema looks good, here's the JSON"

**Right**: "Let me register and load this schema to ensure it works"

**Why**: Many errors only surface during MST generation (schema.load step).

---

## Resources

This skill includes reference materials covering multiple domains and transformation patterns.

### references/

**document-processing-example.md**: Complete KPMG contract parser case study showing discovery outputs → schema transformation for document processing domain.

**data-pipeline-example.md**: Hypothetical Salesforce-to-BigQuery sync showing how the same patterns apply to data pipeline domain.

**webapp-example.md**: Hypothetical component library documentation site showing web application domain patterns.

**enhanced-schema-spec.md**: Complete Enhanced JSON Schema format reference including all x-mst-* extensions, reference patterns, and constraint types.

**transformation-patterns.md**: Detailed algorithms for entity extraction, relationship inference, and constraint extraction from discovery outputs.

**discovery-schema-structure.md**: Documentation of the app-builder-discovery schema structure, entity relationships, and how to query discovery data via Wavesmith MCP.

Load these references when you need examples, detailed format specifications, or transformation guidance.

---

## Final Notes

**Success criteria**:
- Schema is domain-specific (not generic)
- All entities trace to requirements
- Relationships are correctly modeled (reference vs composition)
- Schema validates via schema.load
- User confirms model matches their understanding

**When in doubt**:
- Ask the user for clarification
- Show the conceptual model before generating schema
- Test with schema.load before declaring success
- Iterate based on feedback

**Remember**: This is **collaborative domain modeling**, not automated schema generation. The user's domain expertise is essential for getting the model right.

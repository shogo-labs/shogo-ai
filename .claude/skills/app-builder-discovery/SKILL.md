---
name: app-builder-discovery
description: Guide users through structured discovery process for any app or tool building project. This skill should be used when users have a problem or need but haven't defined a solution architecture. Captures intent as queryable entities in Wavesmith, enabling "runtime as projection over intent" pattern. Use for document processing, data pipelines, web apps, automation workflows, or any building project starting from problem statement rather than technical specification.
---

# App Builder Discovery

## Overview

Guide users through a structured 5-phase discovery process that captures intent, analyzes complexity, and derives requirements before proposing solutions. The discovery data is stored in Wavesmith entities, making the entire conversation queryable and enabling future implementation to project back to captured intent.

This skill teaches **how to run discovery**, not how to build specific solutions. It works across domains: document processing, data pipelines, web apps, automation workflows, etc.

## Working with the app-builder-discovery Schema

Load the schema at the start of every discovery session:

```javascript
wavesmith.schema_load("app-builder-discovery")
```

This loads 6 entity models:

- **DiscoverySession** - Root entity tracking the entire discovery (stores phase, timestamps, references to all other entities)
- **ProblemStatement** - User's problem description, pain points, current approach, desired outcome
- **Artifact** - Uploaded files/examples with flexible tags (varies by domain)
- **Analysis** - Findings from artifact analysis with domain-specific structure, complexity determination
- **Requirement** - What needs to be built, derived from analysis findings (min count varies by complexity)
- **SolutionProposal** - User-facing solution description with phases and deliverables

If you need to see model field definitions:

```javascript
models = wavesmith.store_models("app-builder-discovery")
```

Or read the schema file if needed: `.schemas/app-builder-discovery/schema.json`

### Working with Multiple Schemas

This skill now manages two schemas:
- **app-builder-project**: Tracks the overall project and workspace structure
- **app-builder-discovery**: Tracks the discovery session and related entities

**Schema switching pattern**:

```javascript
// When you need to work with project data:
wavesmith.schema_load("app-builder-project")
// ... work with AppBuilderProject entities ...

// When you need to work with discovery data:
wavesmith.schema_load("app-builder-discovery")
// ... work with DiscoverySession, ProblemStatement, etc. ...
```

**Important**: Always ensure you're in the correct schema before create/update/get/list operations.

**Common pattern for cross-schema operations**:

```javascript
// 1. Get discovery session (in app-builder-discovery schema)
session = wavesmith.store_get("DiscoverySession", session_id)

// 2. Switch to project schema
wavesmith.schema_load("app-builder-project")

// 3. Find project by discovery session reference
projects = wavesmith.store_list("AppBuilderProject", {
  filter: { discoverySessionId: session_id }
})
project = projects[0]

// 4. Get workspace paths
workspace_root = project.workspacePath
discovery_dir = workspace_root + "/" + project.discoveryDir

// 5. Switch back to discovery schema
wavesmith.schema_load("app-builder-discovery")

// 6. Continue with discovery work...
```

## The 5-Phase Discovery Workflow

### Phase 1: Problem Capture

**Goal**: Understand WHY the user needs this

**Process**:
1. Create a DiscoverySession entity to track the entire discovery
2. Ask probing questions to understand:
   - What pain points drive this need?
   - What is the current approach (if any)?
   - What is the desired outcome?
3. Create ProblemStatement entity capturing this understanding
4. Link ProblemStatement to DiscoverySession

**Questions to ask**:
- "What makes [current process] challenging?"
- "How much time does this currently take?"
- "What happens when things go wrong?"
- "What would success look like?"

**Naming the session**:

After capturing problem details, infer a descriptive name for the session:

- **Name**: 2-5 word kebab-case slug (e.g., "contract-template-updater", "invoice-data-extractor")
  - Reflects WHAT is being built: "contract-updater" not "kpmg-processor"
  - Extract from problem description/desired outcome
- **Description**: One-line summary from desired outcome (e.g., "Automated contract update system that compares templates and applies changes at scale")

**Announce to user**: "Starting discovery for: **{Name}**" (convert kebab-case to title case)

**User override**: If user says "Actually call it X", update the name immediately

#### Project Workspace Initialization

After naming the session, create an AppBuilderProject to establish the project workspace structure:

**When to create project**:
- At the start of every new discovery session
- Before creating the DiscoverySession entity

**Detecting workspace path**:
- Use Claude's current working directory as the project workspace root
- Store as absolute path in AppBuilderProject.workspacePath
- All relative directories (discoveryDir, schemaDir, generatedDir) are relative to this root

**Default directory structure**:
```
{workspacePath}/
├── .wavesmith/
│   ├── discovery/          # discoveryDir: ".wavesmith/discovery"
│   ├── schemas/            # schemaDir: ".wavesmith/schemas"
│   └── generated/          # generatedDir: ".wavesmith/generated"
```

**Project creation workflow**:

```javascript
// 1. Load app-builder-project schema
wavesmith.schema_load("app-builder-project")

// 2. Detect workspace path from environment
workspace_path = process.cwd()  // Claude's current working directory

// 3. Check if project already exists for this workspace
existing_projects = wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: workspace_path }
})

// 4a. If project exists, use it
if (existing_projects.length > 0) {
  project = existing_projects[0]
  console.log(`Using existing project: ${project.name}`)
  console.log(`Workspace: ${workspace_path}`)

  // Check if there's an active discovery session
  if (project.discoverySessionId) {
    // Resume or start new session - ask user
    existing_session = wavesmith.store_get("DiscoverySession", project.discoverySessionId)
    // User chooses: resume existing or start fresh
  }
}

// 4b. If no project exists, create new one
else {
  project_id = wavesmith.store_create("AppBuilderProject", {
    "id": "proj-" + generateUniqueId(),
    "name": inferred_name,  // Same as session name
    "workspacePath": workspace_path,
    "discoveryDir": ".wavesmith/discovery",
    "schemaDir": ".wavesmith/schemas",
    "generatedDir": ".wavesmith/generated",
    "createdAt": Date.now(),
    "lastUpdatedAt": Date.now()
  })

  project = wavesmith.store_get("AppBuilderProject", project_id)
  console.log(`Created new project: ${project.name}`)
  console.log(`Workspace: ${workspace_path}`)
}

// 5. Create workspace directories
mkdir -p {workspace_path}/.wavesmith/discovery
mkdir -p {workspace_path}/.wavesmith/schemas
mkdir -p {workspace_path}/.wavesmith/generated

// 6. Load app-builder-discovery schema for session tracking
wavesmith.schema_load("app-builder-discovery")
```

**Important considerations**:
- AppBuilderProject uses a separate schema workspace parameter
- Must switch between app-builder-project and app-builder-discovery schemas
- Project name should match session name for consistency
- Workspace path is always absolute, directories are relative

**Wavesmith patterns**:

```javascript
// 1. Create ProblemStatement first
prob_id = wavesmith.store_create("ProblemStatement", {
  "id": "prob-" + generateUniqueId(),
  "description": "Full problem description from user",
  "painPoints": [
    "Pain point 1",
    "Pain point 2",
    "Pain point 3"
  ],
  "currentApproach": "How they do it now (or null if none)",
  "desiredOutcome": "What they want to achieve",
  "createdAt": Date.now()
})

// 2. Infer name and description from problem statement
inferred_name = "contract-template-updater"  // kebab-case, 2-5 words
inferred_description = "Automated contract update system that compares templates and applies changes at scale"

// 3. Create DiscoverySession with name, description, and problem reference
session_id = wavesmith.store_create("DiscoverySession", {
  "id": "sess-" + generateUniqueId(),
  "name": inferred_name,
  "description": inferred_description,
  "currentPhase": "artifact_collection",
  "problemStatement": prob_id,
  "startedAt": Date.now(),
  "lastUpdatedAt": Date.now()
})

// 4. Link DiscoverySession to AppBuilderProject
wavesmith.schema_load("app-builder-project")
wavesmith.store_update("AppBuilderProject", project.id, {
  "discoverySessionId": session_id,
  "lastUpdatedAt": Date.now()
})
wavesmith.schema_load("app-builder-discovery")  // Switch back for session work
```

**Transition criteria**: When pain points, current approach, and desired outcome are clear

**Next phase**: artifact_collection

### Phase 2: Artifact Collection

**Goal**: Understand WHAT exists (files, examples, references)

**Process**:
1. Request examples: templates, input files, schemas, wireframes, etc.
2. **When first artifact arrives**, set up workspace (Phase 2a)
3. For each uploaded file, create an Artifact entity and copy to workspace
4. Use flexible tags to categorize (varies by domain)
5. Link artifacts to DiscoverySession

#### Phase 2a: Workspace Setup (Lazy - When First Artifact Arrives)

**When to create workspace**: When user provides the first artifact

**Workspace structure**:
```
{workspacePath}/.wavesmith/discovery/
└── artifacts/          # User files copied here
```

**Setup steps**:
1. Retrieve project to get workspace path:
   ```javascript
   wavesmith.schema_load("app-builder-project")
   projects = wavesmith.store_list("AppBuilderProject", {
     filter: { discoverySessionId: session_id }
   })
   project = projects[0]
   wavesmith.schema_load("app-builder-discovery")

   discovery_path = project.workspacePath + "/" + project.discoveryDir
   artifacts_path = discovery_path + "/artifacts"
   ```

2. Create artifacts directory if it doesn't exist:
   ```bash
   mkdir -p {artifacts_path}
   ```

3. Update DiscoverySession with discovery path:
   ```javascript
   wavesmith.store_update("DiscoverySession", session_id, {
     "workspacePath": discovery_path,
     "lastUpdatedAt": Date.now()
   })
   ```

**Note**: The workspace directories (.wavesmith/discovery, .wavesmith/schemas, .wavesmith/generated) were already created during project initialization in Phase 1.

**Announce**: "Setting up workspace at: `{discovery_path}/`"

#### Copying Files to Workspace

**Questions to ask**:
- "Do you have example [documents/data/designs]?"
- "Are there templates or reference materials?"
- "Can you show me what the input/output looks like?"

**When user provides file path**:

1. Copy file to workspace artifacts folder
2. Create Artifact entity with both source and workspace paths
3. Link to session

**Note on language**: We say "upload" for user-friendly communication, but in CLI practice we're copying files from disk locations to an isolated workspace.

**Wavesmith patterns**:

```javascript
// User provides: /Users/ryan/kpmg/contract1.docx

// 1. Get session and workspace path
session = wavesmith.store_get("DiscoverySession", session_id)
workspace_path = session.workspacePath  // e.g., ".../workspaces/contract-updater"
source_path = "/Users/ryan/kpmg/contract1.docx"
filename = "contract1.docx"  // basename only

// 2. Copy file to workspace
workspace_artifact_path = workspace_path + "/artifacts/" + filename
// Execute: cp "{source_path}" "{workspace_artifact_path}"

// 3. Create Artifact entity with both paths
art_id = wavesmith.store_create("Artifact", {
  "id": "art-" + generateUniqueId(),
  "filename": filename,  // Just the basename
  "sourcePath": source_path,  // Original full path from user
  "workspacePath": workspace_artifact_path,  // Where we copied it
  "format": "docx",  // or pdf, csv, json, png, etc.
  "sizeBytes": 487424,
  "tags": [
    // Flexible! Varies by domain:
    // Document processing: ["template", "2024", "pw-styles"]
    // Invoice processing: ["invoice", "vendor-a", "purchase-order"]
    // Web app: ["wireframe", "mockup", "v2"]
  ],
  "notes": "Optional context about this artifact",
  "uploadedAt": Date.now()
})

// 4. Add to session artifacts array
current_artifacts = session.artifacts || []
wavesmith.store_update("DiscoverySession", session_id, {
  "artifacts": [...current_artifacts, art_id],
  "lastUpdatedAt": Date.now()
})

// 5. For all subsequent analysis, use workspacePath
// Read from: workspace_artifact_path (NOT source_path)
```

**Transition criteria**: When artifacts are uploaded or user indicates none available

**Next phase**: analysis

### Phase 3: Analysis

#### Before Starting Analysis: Setup Analysis Environment (When Needed)

**When entering Phase 3 with files requiring Python tools** (DOCX, PDF, images):

**Step 1: Get workspace path from session**:

```javascript
// Get the workspace path from the discovery session
session = wavesmith.store_get("DiscoverySession", session_id)
workspace_path = session.workspacePath  // e.g., ".wavesmith/discovery"
venv_path = workspace_path + "/.venv"
```

**Step 2: Check if .venv exists and create if needed**:

```bash
# Check and create venv at workspace location (no cd needed)
if [ ! -d "{venv_path}" ]; then
  echo "Setting up analysis environment at {workspace_path}..."
  python3 -m venv {venv_path}
  source {venv_path}/bin/activate
  pip install defusedxml python-docx  # Always needed for DOCX analysis
else
  source {venv_path}/bin/activate
fi
```

**Example with actual paths**:
```bash
# If workspace_path = ".wavesmith/discovery"
if [ ! -d ".wavesmith/discovery/.venv" ]; then
  echo "Setting up analysis environment at .wavesmith/discovery..."
  python3 -m venv .wavesmith/discovery/.venv
  source .wavesmith/discovery/.venv/bin/activate
  pip install defusedxml python-docx
else
  source .wavesmith/discovery/.venv/bin/activate
fi
```

**Install additional dependencies based on file types**:
- **DOCX files**: `defusedxml python-docx` (already installed above)
- **PDF files**: `pip install pypdf2 pdfplumber`
- **Images**: `pip install pillow opencv-python`
- **Excel**: `pip install openpyxl pandas`

**When NOT to create .venv**:
- Text files (.txt, .md) - no Python tools needed
- JSON/CSV files - Python stdlib handles these
- Files analyzed via pandoc only (markdown conversion)

**All Python scripts must use workspace venv**:
- Pattern: `source {venv_path}/bin/activate && python {workspace_path}/script.py`
- Example: `source .wavesmith/discovery/.venv/bin/activate && python .wavesmith/discovery/analyze_docx.py`
- DOCX unpacking scripts require venv activation

**Announce** (only if creating new venv): "Setting up analysis environment at {workspace_path}..."

---

**Goal**: Determine HOW complex this is

**Process**:
1. Read and analyze uploaded artifacts
2. Detect patterns, structure, conditional logic, business rules
3. Determine complexity level: low, medium, or high
4. Create Analysis entity with domain-specific findings
5. Write plain-language rationale for complexity determination

**Complexity guidelines**:

**Low complexity** - Simple patterns, no conditional logic:
- Variable substitution ({{name}}, {{date}})
- Linear processes
- No embedded business rules
- Examples: Email templates, simple forms, basic data transformation

**Medium complexity** - Structured data with validation:
- Tables, nested objects, arrays
- Validation rules and calculations
- No conditional content selection
- Examples: Invoices, purchase orders, structured data extraction

**High complexity** - Conditional logic and business rules:
- If/then/else logic in structure or formatting
- Business rules embedded in document structure
- Multiple option paths
- Complex state machines
- Examples: Tax documents with PW_ styles, legal contracts with clauses, applications with complex workflows

**Wavesmith patterns**:

```javascript
ana_id = wavesmith.store_create("Analysis", {
  "id": "ana-" + generateUniqueId(),
  "artifacts": ["art-001", "art-002"],  // References
  "findings": {
    // DOMAIN-SPECIFIC STRUCTURE!
    // This object varies based on what you discovered

    // Document processing example:
    // "totalSections": 81,
    // "documentStructure": {"headingLevels": 3, "topLevelSections": 15},
    // "detectedPatterns": {"pwStyles": [...], "snippetIds": 104}

    // Data pipeline example:
    // "sourceObjects": 47,
    // "relationships": {"nested": 12, "lookups": 8},
    // "customFields": 23

    // Web app example:
    // "screenCount": 5,
    // "features": ["auth", "crud", "filtering", "tags"],
    // "dataModel": {"entities": 3, "relationships": 4}
  },
  "complexity": "low|medium|high",
  "complexityRationale": "Plain language explanation of why this complexity level. Reference specific findings.",
  "analyzedAt": Date.now()
})

// Update session
wavesmith.store_update("DiscoverySession", session_id, {
  "currentPhase": "requirements",
  "analysis": ana_id,
  "lastUpdatedAt": Date.now()
})
```

**Transition criteria**: When complexity is determined with rationale

**Next phase**: requirements

### Phase 4: Requirements Elicitation

**Goal**: Define WHAT needs to be built

**Process**:
1. Derive requirements from analysis findings (not assumptions!)
2. Create minimum number of requirements based on complexity:
   - Low: minimum 3 requirements
   - Medium: minimum 5 requirements
   - High: minimum 7 requirements
3. For each requirement, specify: description, category, priority, acceptance criteria
4. Link each requirement to the analysis (derivedFrom)

**Requirement derivation examples**:

Finding → Requirement:
- "Detected PW_ styles" → "Preserve paragraph style metadata"
- "Tables with calculated fields" → "Validate calculations match formulas"
- "{{variables}} in template" → "Safely substitute variables with validation"
- "Nested relationships in schema" → "Maintain referential integrity during sync"

**Categories are free-form** (adapt to domain):
- Document processing: extraction, preservation, matching, comparison
- Data pipeline: extraction, transformation, loading, validation, scheduling
- Web app: authentication, crud, filtering, persistence, ui

**Wavesmith patterns**:

```javascript
req_id = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "What needs to be built (specific and actionable)",
  "category": "extraction|validation|...",  // Free-form, adapt to domain
  "priority": "critical|high|medium|low",
  "acceptanceCriteria": [
    "Criterion 1: measurable outcome",
    "Criterion 2: specific behavior",
    "Criterion 3: validation check"
  ],
  "derivedFrom": ana_id,  // Creates inverse relationship!
  "createdAt": Date.now()
})

// Repeat for all requirements (min 3/5/7 based on complexity)
```

**Checking requirement count**:

```javascript
requirements = wavesmith.store_list("Requirement")
relevant_reqs = requirements.filter(r => r.derivedFrom === ana_id)

session = wavesmith.store_get("DiscoverySession", session_id)
analysis = wavesmith.store_get("Analysis", session.analysis)

min_required = {
  "low": 3,
  "medium": 5,
  "high": 7
}

if (relevant_reqs.length < min_required[analysis.complexity]) {
  // Need more requirements!
}
```

**Transition criteria**: When minimum requirements met and all are derived from findings

**Next phase**: edge_case_discovery

---

### Phase 4a: Edge Case Discovery & Requirement Extension

**Goal**: Systematically probe for edge cases, failure modes, boundary conditions, and scale considerations that extend beyond the "happy path" requirements captured so far.

**Why This Phase Matters**:

Initial discovery focuses on core functionality and primary workflows. This phase ensures we don't miss critical scenarios that cause real-world failures:
- What happens when expected data is missing or malformed?
- How do we handle validation failures or constraint violations?
- What are the scale limits and performance boundaries?
- How do we detect and respond to anomalous conditions?
- What recovery mechanisms are needed for partial failures?

**Process**:

#### 1. Review Current Requirements

First, load and review all requirements captured so far:

```javascript
// Retrieve all requirements from Wavesmith
all_reqs = wavesmith.store_list("Requirement", {})
relevant_reqs = all_reqs.filter(r => r.derivedFrom === ana_id)

console.log(`Current requirements: ${relevant_reqs.length}`)
```

#### 2. Systematic Edge Case Probing

Use these five probing categories to uncover missing requirements. For each category, ask targeted questions and capture new requirements in Wavesmith.

**Category 1: Missing/Incomplete Data**

Probe Questions:
- What if expected items are missing from the collection?
- What if required fields are empty or null?
- What if references to related items are broken?
- What if parent-child relationships are incomplete?
- What if configuration data is missing or corrupted?

**Category 2: Validation/Verification Failures**

Probe Questions:
- What if data fails validation rules?
- What if computed values are out of expected ranges?
- What if cross-field validation fails (e.g., end date before start date)?
- What if checksums or integrity checks fail?
- What if business rules are violated?

**Category 3: Error Handling & Recovery**

Probe Questions:
- What if external service calls fail or timeout?
- What if database connections are lost mid-operation?
- What if file operations fail (disk full, permissions)?
- What if the system crashes mid-processing?
- What if network interruptions occur during data transfer?

**Category 4: Scale & Performance Boundaries**

Probe Questions:
- What if the collection contains 10x, 100x, 1000x the expected items?
- What if individual items are much larger than expected?
- What if concurrent requests exceed capacity?
- What if memory usage grows unbounded?
- What if processing time exceeds acceptable limits?

**Category 5: Data Quality Issues**

Probe Questions:
- What if input data is poorly formatted or contains unexpected characters?
- What if numeric fields contain non-numeric data?
- What if text encoding is incorrect (UTF-8 vs. Latin-1)?
- What if data contains inconsistencies or contradictions?
- What if timestamps are in unexpected formats or timezones?

**Decision Framework**:

For each concern identified:

- **Create new requirement** → If the concern is critical to system success and needs its own interface/implementation
- **Extend existing requirement** → If the concern is an edge case of an existing requirement (add to acceptance criteria)
- **Document as assumption** → If the concern is out of scope or acceptable risk

Aim for 2-4 new requirements from this pass. If you identify 5+ new requirements, flag for user review - may indicate complexity was underestimated.

**Wavesmith patterns**:

```javascript
// Example: Completeness validation requirement
req_edge_01 = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Detect when expected items are missing from processed results",
  "category": "validation",
  "priority": "high",
  "rationale": "System must identify gaps in expected item collections to ensure completeness",
  "acceptanceCriteria": [
    "Identify gaps in expected item sequence (e.g., items 1,2,4,5 - missing 3)",
    "Compare processed items against expected set from configuration",
    "Flag missing items in validation results with specific identifiers",
    "Handle various item identification schemes (numeric IDs, UUIDs, composite keys)"
  ],
  "derivedFrom": ana_id,
  "createdAt": Date.now()
})

// Example: Error handling requirement
req_edge_02 = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Implement retry logic with exponential backoff for transient failures",
  "category": "reliability",
  "priority": "high",
  "rationale": "External dependencies may fail temporarily; system should recover automatically",
  "acceptanceCriteria": [
    "Retry failed operations up to N times (configurable)",
    "Use exponential backoff between retries (e.g., 1s, 2s, 4s, 8s)",
    "Distinguish transient errors (retry) from permanent errors (fail)",
    "Log all retry attempts with error details",
    "Support circuit breaker pattern to avoid cascading failures"
  ],
  "derivedFrom": ana_id,
  "createdAt": Date.now()
})

// Example: Scale/performance requirement
req_edge_03 = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Process large collections using streaming/batching to avoid memory exhaustion",
  "category": "performance",
  "priority": "medium",
  "rationale": "System must handle unexpectedly large inputs without crashing",
  "acceptanceCriteria": [
    "Process collections in configurable batch sizes (e.g., 100 items)",
    "Use streaming/iterator pattern to avoid loading entire collection into memory",
    "Monitor memory usage and enforce limits",
    "Provide progress reporting for long-running operations",
    "Support graceful degradation (partial results on timeout)"
  ],
  "derivedFrom": ana_id,
  "createdAt": Date.now()
})
```

**Anti-patterns to avoid**:

❌ "What if user uploads wrong file?" → Too generic, not requirement-specific
❌ "What if database is down?" → Infrastructure concern, not application logic
❌ "What if we need multi-language support?" → Feature expansion, not edge case
✅ "What if reference to related item doesn't exist?" → Specific failure mode
✅ "What if validation fails for 50% of items?" → Actionable error handling scenario

**Transition criteria**: When edge case probing complete and 2-4 new requirements created (or documented why none needed)

**Next phase**: requirement_consolidation

---

### Phase 4b: Requirement Consolidation & Specification Finalization

**Goal**: Consolidate core requirements (Phase 4) with edge case requirements (Phase 4a) into a unified, prioritized, conflict-free specification ready for schema design.

**Why This Phase Matters**:

Edge case discovery often reveals:
- **Overlaps**: Multiple requirements addressing similar concerns
- **Conflicts**: Requirements with contradictory acceptance criteria
- **Gaps**: Missing connections between core and edge case requirements
- **Prioritization needs**: Trade-offs between features, performance, and complexity

This phase ensures a clean, coherent specification.

**Process**:

#### 1. Retrieve All Requirements

```javascript
// Get all requirements (core + edge cases)
all_requirements = wavesmith.store_list("Requirement", {})
relevant_reqs = all_requirements.filter(r => r.derivedFrom === ana_id)

console.log(`Total requirements: ${relevant_reqs.length}`)

// Group by category
by_category = relevant_reqs.reduce((acc, req) => {
  if (!acc[req.category]) acc[req.category] = []
  acc[req.category].push(req)
  return acc
}, {})
```

#### 2. Identify Overlaps & Duplicates

Look for requirements that address the same concern:

**Example - Complementary (Keep Both)**:
- req-003: "Process all items in collection"
- req-edge-001: "Detect when expected items are missing"
- **Analysis**: Different concerns (processing vs validation)
- **Action**: Link them, no merge needed

**Example - Overlapping (Merge)**:
- req-007: "Validate data format"
- req-edge-002: "Handle validation failures"
- **Analysis**: Related concerns, can be unified
- **Action**: Merge into comprehensive validation requirement

```javascript
// Merge overlapping requirements
req_merged = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Validate data format and handle validation failures with clear error reporting",
  "category": "validation",
  "priority": "high",
  "rationale": "Data must meet format requirements; failures must be reported clearly for correction",
  "acceptanceCriteria": [
    // From req-007:
    "Validate all critical fields against defined format rules",
    "Support multiple data formats as needed",
    // From req-edge-002:
    "Collect all validation errors (not just first failure)",
    "Provide actionable error messages with field names and expected formats",
    "Support partial processing (valid items proceed, invalid items quarantined)",
    "Log validation failures for analysis and rule refinement"
  ],
  "derivedFrom": ana_id,
  "supersedes": ["req-007", "req-edge-002"],
  "createdAt": Date.now()
})

// Mark old requirements as superseded
wavesmith.store_update("Requirement", "req-007", {
  status: "superseded",
  supersededBy: req_merged.id
})
wavesmith.store_update("Requirement", "req-edge-002", {
  status: "superseded",
  supersededBy: req_merged.id
})
```

#### 3. Resolve Conflicts

Identify requirements with contradictory acceptance criteria and resolve with user input:

**Example Conflict**:
- req-004: "Process items in strict sequential order"
- req-edge-003: "Process large collections using parallel batching"

**Resolution Options**:
1. Prioritize one approach (sequential or parallel)
2. Conditional approach (sequential for small, parallel for large)
3. Make it configurable (user chooses strategy)

Present conflict to user and capture resolution:

```javascript
// After user decides (example: conditional approach):
req_resolved = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Process items with scale-adaptive strategy",
  "category": "performance",
  "priority": "high",
  "rationale": "Small collections benefit from sequential simplicity; large collections require parallel processing",
  "acceptanceCriteria": [
    "For collections <1000 items: process sequentially in order",
    "For collections >=1000 items: process in parallel batches of 100",
    "Maintain ordering guarantees within batches",
    "Support configurable threshold and batch size"
  ],
  "derivedFrom": ana_id,
  "supersedes": ["req-004", "req-edge-003"],
  "createdAt": Date.now()
})
```

#### 4. Fill Gaps

Identify missing connections or implied requirements:

**Example Gap**: Requirements mention validation and error handling but don't specify how errors are surfaced to users/API consumers.

```javascript
// Create gap-filling requirement
req_gap_01 = wavesmith.store_create("Requirement", {
  "id": "req-" + generateUniqueId(),
  "description": "Provide error reporting interface for validation and processing failures",
  "category": "integration",
  "priority": "high",
  "rationale": "Validation and error handling requirements imply need for error visibility",
  "acceptanceCriteria": [
    "Expose validation errors via API response (structured error format)",
    "Include error details: field name, error type, suggested fix",
    "Support error log retrieval for batch operations",
    "Provide error summary statistics (total errors, error types)"
  ],
  "derivedFrom": ana_id,
  "relatedRequirements": [req_merged.id, req_edge_02.id],
  "createdAt": Date.now()
})
```

#### 5. Prioritize Requirements

Use MoSCoW method (Must have, Should have, Could have, Won't have):

```javascript
// Update priorities after consolidation
final_active_reqs = wavesmith.store_list("Requirement", {
  filter: {
    derivedFrom: ana_id,
    status: { $ne: "superseded" }
  }
})

// Review with user and update priorities
// Example:
wavesmith.store_update("Requirement", req_001.id, { priority: "must-have" })
wavesmith.store_update("Requirement", req_edge_01.id, { priority: "must-have" })
wavesmith.store_update("Requirement", req_edge_03.id, { priority: "should-have" })
```

#### 6. Generate Final Specification Summary

Present consolidated requirements to user:

```javascript
final_summary = {
  "totalRequirements": final_active_reqs.length,
  "mustHave": final_active_reqs.filter(r => r.priority === "must-have").length,
  "shouldHave": final_active_reqs.filter(r => r.priority === "should-have").length,
  "couldHave": final_active_reqs.filter(r => r.priority === "could-have").length,
  "byCategory": by_category
}

console.log("CONSOLIDATED SPECIFICATION:")
console.log(`Total Requirements: ${final_summary.totalRequirements}`)
console.log(`Must Have: ${final_summary.mustHave}`)
console.log(`Should Have: ${final_summary.shouldHave}`)
console.log(`Could Have: ${final_summary.couldHave}`)
```

**Transition criteria**: When requirements are consolidated, conflicts resolved, gaps filled, and priorities assigned

**Next phase**: solution_design

### Phase 5: Solution Proposal

**Goal**: Describe WHAT we'll build in user-facing language

**Process**:
1. Draft a solution proposal using plain language (no jargon!)
2. Break solution into phases with clear goals
3. Specify deliverables for each phase
4. Link to requirements being addressed
5. Request user approval

**User-facing language principles**:
- Speak in capabilities, not architecture
- "Document processor that extracts rules" NOT "Pydantic parser with JSON Schema"
- "Data pipeline that syncs Salesforce to BigQuery" NOT "ETL with Airflow DAGs"
- "Todo app with filtering and tagging" NOT "React SPA with Redux state management"

Technical decisions (Wavesmith, Pydantic, React, etc.) are **implementation details** - save for implementation phase.

**Wavesmith patterns**:

```javascript
sol_id = wavesmith.store_create("SolutionProposal", {
  "id": "sol-" + generateUniqueId(),
  "summary": "One sentence describing what we'll build (user-friendly)",
  "rationale": "Plain language explanation of WHY this approach makes sense given the complexity and findings",
  "phases": [
    {
      "name": "Phase 1 name",
      "goal": "What this phase accomplishes",
      "deliverables": [
        "Specific deliverable 1",
        "Specific deliverable 2",
        "Specific deliverable 3"
      ],
      "estimatedTime": "~45 minutes"  // Optional but helpful
    },
    {
      "name": "Phase 2 name",
      "goal": "What this phase accomplishes",
      "deliverables": ["..."],
      "estimatedTime": "~30 minutes"
    }
  ],
  "requirementsAddressed": ["req-001", "req-002", "req-003", ...],
  "createdAt": Date.now()
})

// Update session
wavesmith.store_update("DiscoverySession", session_id, {
  "currentPhase": "approved",  // or stay in solution_design until user approves
  "solutionProposal": sol_id,
  "lastUpdatedAt": Date.now()
})
```

**Transition criteria**: User approves the proposal

**Next phase**: approved (discovery complete) or implementation (separate workflow)

## Querying Discovery State

At any point, query the session to understand current state:

```javascript
// Get the full session
session = wavesmith.store_get("DiscoverySession", session_id)

// What phase are we in?
current_phase = session.currentPhase  // problem_capture, artifact_collection, etc.

// Get linked entities
problem = wavesmith.store_get("ProblemStatement", session.problemStatement)
artifacts = session.artifacts.map(id => wavesmith.store_get("Artifact", id))
analysis = wavesmith.store_get("Analysis", session.analysis)
proposal = wavesmith.store_get("SolutionProposal", session.solutionProposal)

// Get all requirements for this analysis
all_requirements = wavesmith.store_list("Requirement")
session_requirements = all_requirements.filter(r => r.derivedFrom === session.analysis)

// Answer user questions like "Why this approach?"
console.log(analysis.complexityRationale)
console.log(proposal.rationale)
```

## Querying Project State

At any point, query the project to understand workspace structure and cross-schema relationships:

```javascript
// Get project for current workspace
wavesmith.schema_load("app-builder-project")
projects = wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: process.cwd() }
})
project = projects[0]

// Get linked discovery session
if (project.discoverySessionId) {
  wavesmith.schema_load("app-builder-discovery")
  session = wavesmith.store_get("DiscoverySession", project.discoverySessionId)

  // Project paths
  console.log(`Discovery artifacts: ${project.workspacePath}/${project.discoveryDir}/artifacts`)
  console.log(`Schemas: ${project.workspacePath}/${project.schemaDir}`)
  console.log(`Generated code: ${project.workspacePath}/${project.generatedDir}`)

  // Discovery state
  console.log(`Session: ${session.name}`)
  console.log(`Phase: ${session.currentPhase}`)
}

// Get domain schema (if created by schema-designer)
if (project.domainSchemaId) {
  console.log(`Domain schema: ${project.domainSchemaId}`)
  // This will be used by schema-designer and implementation-spec skills
}
```

### Checking for Existing Projects

When starting a new discovery session, always check if a project already exists in the current workspace:

```javascript
wavesmith.schema_load("app-builder-project")
workspace_path = process.cwd()

existing_projects = wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: workspace_path }
})

if (existing_projects.length > 0) {
  project = existing_projects[0]

  // Check if there's an active discovery
  if (project.discoverySessionId) {
    wavesmith.schema_load("app-builder-discovery")
    existing_session = wavesmith.store_get("DiscoverySession", project.discoverySessionId)

    // Present options to user:
    // 1. Resume existing session (if incomplete)
    // 2. Start new session (archives old one)
    // 3. View existing session results
  } else {
    // Project exists but no active discovery
    // Safe to start new discovery
  }
}
```

## Phase Gates and Validation

Enforce proper discovery flow:

```javascript
// Before starting discovery, ensure project is properly initialized
wavesmith.schema_load("app-builder-project")
projects = wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: process.cwd() }
})

if (projects.length === 0) {
  // Must create project first (Phase 1 initialization)
  console.log("ERROR: No project found. Initialize project in Phase 1.")
  return
}

project = projects[0]

// Verify workspace directories exist
required_dirs = [
  project.workspacePath + "/" + project.discoveryDir,
  project.workspacePath + "/" + project.schemaDir,
  project.workspacePath + "/" + project.generatedDir
]

// Check and create missing directories
required_dirs.forEach(dir => {
  // mkdir -p {dir}
})

// Switch back to discovery schema
wavesmith.schema_load("app-builder-discovery")

// Can't move to analysis without artifacts
if (currentPhase === "artifact_collection" && session.artifacts.length === 0) {
  // Request artifacts or allow user to proceed without (rare)
}

// Can't move to requirements without analysis
if (currentPhase === "analysis" && !session.analysis) {
  // Must complete analysis first
}

// Can't move to solution without minimum requirements
if (currentPhase === "requirements") {
  analysis = wavesmith.store_get("Analysis", session.analysis)
  requirements = wavesmith.store_list("Requirement").filter(r => r.derivedFrom === session.analysis)

  min_required = {"low": 3, "medium": 5, "high": 7}

  if (requirements.length < min_required[analysis.complexity]) {
    // Need more requirements before proposing solution
  }
}
```

## Resources

This skill includes reference materials that provide detailed examples and guidelines:

### references/

**example-sessions.md**: Complete discovery session examples across three complexity levels (KPMG high complexity, invoice medium complexity, email low complexity). Shows full conversation flow with Wavesmith entity creation patterns. Grep-able for specific patterns.

**complexity-guide.md**: Detailed complexity assessment patterns with examples. Helps recognize signals for low/medium/high complexity across different domains.

Load these references when you need detailed examples or are uncertain about complexity assessment.

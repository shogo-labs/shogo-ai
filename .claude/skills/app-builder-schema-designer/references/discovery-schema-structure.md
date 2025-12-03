# app-builder-discovery Schema Structure

This document explains the **app-builder-discovery schema** structure and how to query discovery outputs via Wavesmith MCP.

---

## Overview

The app-builder-discovery schema captures the output of the discovery process. It consists of 6 entity types that track the progression from problem statement through solution proposal.

**Schema location**: `.schemas/app-builder-discovery/` (relative to project root)

---

## Loading the Schema

Before querying discovery data, load the schema:

```javascript
// Load schema + data
result = wavesmith.schema_load("app-builder-discovery")

// Returns:
{
  ok: true,
  schemaId: "uuid",
  models: [
    { name: "DiscoverySession", fields: [...] },
    { name: "ProblemStatement", fields: [...] },
    { name: "Artifact", fields: [...] },
    { name: "Analysis", fields: [...] },
    { name: "Requirement", fields: [...] },
    { name: "SolutionProposal", fields: [...] }
  ]
}
```

This loads the schema definition AND all saved entity instances from `.schemas/app-builder-discovery/data/`.

---

## Entity Types

### 1. DiscoverySession

**Purpose**: Root entity orchestrating the entire discovery process.

**Key fields**:
- `id` (string) - Session identifier (e.g., "sess-001")
- `name` (string) - Kebab-case session name (e.g., "document-approval-system")
- `description` (string) - User-friendly description
- `currentPhase` (enum) - Current workflow phase
- `workspacePath` (string) - Absolute path to session workspace
- `problemStatement` (reference) → ProblemStatement
- `artifacts` (array reference) → Artifact[]
- `analysis` (reference) → Analysis
- `solutionProposal` (reference) → SolutionProposal
- `startedAt` (number) - Timestamp when session started
- `lastUpdatedAt` (number) - Timestamp of last modification

**Phases enum**:
```json
["problem_capture", "artifact_collection", "analysis", "requirements", "solution_design", "approved", "implementation"]
```

**Query example**:
```javascript
// Get session by ID
session = wavesmith.store_get("DiscoverySession", "sess-001")

// List all sessions
allSessions = wavesmith.store_list("DiscoverySession")
```

---

### 2. ProblemStatement

**Purpose**: Captures the problem being solved (the WHY).

**Key fields**:
- `id` (string) - Problem identifier (e.g., "prob-001")
- `description` (string) - Problem description
- `painPoints` (array of strings) - Specific pain points
- `currentApproach` (string, optional) - Existing solution (if any)
- `desiredOutcome` (string) - What success looks like
- `createdAt` (number) - Timestamp

**Example**:
```json
{
  "id": "prob-001",
  "description": "Documents need approval workflow with comment tracking",
  "painPoints": [
    "Currently tracking approvals in spreadsheets",
    "Comments get lost in email threads",
    "No audit trail"
  ],
  "currentApproach": "Manual email-based approval process",
  "desiredOutcome": "Centralized system with approval tracking and comments",
  "createdAt": 1735510000000
}
```

**Query example**:
```javascript
// Get problem from session
problem = wavesmith.store_get("ProblemStatement", session.problemStatement)
```

---

### 3. Artifact

**Purpose**: Represents uploaded files (templates, examples, designs, data samples).

**Key fields**:
- `id` (string) - Artifact identifier (e.g., "art-001")
- `filename` (string) - Original filename
- `format` (string) - File extension/type
- `sizeBytes` (number) - File size
- `tags` (array of strings) - Descriptive tags (domain-specific)
- `notes` (string, optional) - Additional context
- `sourcePath` (string, optional) - Original location
- `workspacePath` (string, optional) - Workspace location
- `uploadedAt` (number) - Timestamp

**Example**:
```json
{
  "id": "art-001",
  "filename": "approval_template.docx",
  "format": "docx",
  "sizeBytes": 252000,
  "tags": ["template", "approval-form"],
  "notes": "Current approval form used by legal team",
  "sourcePath": "/Users/john/Documents/approval_template.docx",
  "workspacePath": "/path/to/workspace/artifacts/approval_template.docx",
  "uploadedAt": 1735511000000
}
```

**Query example**:
```javascript
// Get all artifacts for session
artifacts = session.artifacts.map(id => wavesmith.store_get("Artifact", id))

// Or list all and filter
allArtifacts = wavesmith.store_list("Artifact")
sessionArtifacts = allArtifacts.filter(a => session.artifacts.includes(a.id))
```

---

### 4. Analysis

**Purpose**: Results of artifact/domain analysis (complexity, patterns, domain context).

**Key fields**:
- `id` (string) - Analysis identifier (e.g., "ana-001")
- `artifacts` (array reference) → Artifact[] - Which artifacts were analyzed
- `findings` (object) - **Domain-specific flexible structure**
- `complexity` (enum) - ["low", "medium", "high"]
- `complexityRationale` (string) - Why this complexity level
- `analyzedAt` (number) - Timestamp

**Findings structure**: Flexible object that varies by domain

**Document processing example**:
```json
"findings": {
  "documentTypes": ["report", "proposal"],
  "workflowStates": ["draft", "in_review", "approved"],
  "reviewerRoles": ["technical", "manager", "legal"]
}
```

**Data pipeline example**:
```json
"findings": {
  "sourceSystem": "CRM API",
  "recordTypes": ["customer", "order"],
  "transformations": ["field_mapping", "validation"],
  "recordVolume": "10000-50000 per sync"
}
```

**Query example**:
```javascript
// Get analysis from session
analysis = wavesmith.store_get("Analysis", session.analysis)

// Access findings (domain-specific)
console.log(analysis.findings.documentTypes)  // ["report", "proposal"]
```

---

### 5. Requirement

**Purpose**: Individual requirements derived from analysis.

**Key fields**:
- `id` (string) - Requirement identifier (e.g., "req-001", "req-002")
- `description` (string) - What the requirement specifies
- `category` (string) - **Domain-specific category** (e.g., "extraction", "validation")
- `priority` (enum) - ["critical", "high", "medium", "low"]
- `acceptanceCriteria` (array of strings) - Testable criteria
- `derivedFrom` (reference) → Analysis - Which analysis produced this requirement
- `createdAt` (number) - Timestamp

**Example**:
```json
{
  "id": "req-001",
  "description": "System must capture document metadata including title, type, and upload date",
  "category": "extraction",
  "priority": "critical",
  "acceptanceCriteria": [
    "Captures document title, type, and upload timestamp",
    "Records who uploaded the document"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1735512000000
}
```

**Query example**:
```javascript
// Get all requirements for an analysis
allRequirements = wavesmith.store_list("Requirement")
analysisRequirements = allRequirements.filter(r => r.derivedFrom === session.analysis)

// Or if you have analysis object
requirements = all Requirements.filter(r => r.derivedFrom === analysis.id)
```

---

### 6. SolutionProposal

**Purpose**: Proposed implementation approach with phases.

**Key fields**:
- `id` (string) - Proposal identifier (e.g., "sol-001")
- `summary` (string) - One-sentence user-friendly summary
- `rationale` (string) - Why this approach
- `phases` (array of phase objects) - Implementation phases
- `requirementsAddressed` (array reference) → Requirement[] - Which requirements this addresses
- `createdAt` (number) - Timestamp

**Phase structure**:
```json
{
  "name": "string",
  "goal": "string",
  "deliverables": ["string"],
  "estimatedTime": "string (optional)"
}
```

**Example**:
```json
{
  "id": "sol-001",
  "summary": "Document approval system with workflow tracking and comment management",
  "rationale": "Given medium complexity from multiple reviewers and comment tracking, we'll build in two phases: first the document/review entities, then the workflow engine.",
  "phases": [
    {
      "name": "Core Data Model",
      "goal": "Build document and review entities with comment storage",
      "deliverables": [
        "Document entity with metadata",
        "Review entity with status tracking",
        "Comment storage within reviews"
      ],
      "estimatedTime": "~2 hours"
    },
    {
      "name": "Workflow Engine",
      "goal": "Implement approval logic and status transitions",
      "deliverables": [
        "Reviewer assignment logic",
        "Status transition rules",
        "Approval completion detection"
      ],
      "estimatedTime": "~3 hours"
    }
  ],
  "requirementsAddressed": ["req-001", "req-002", "req-003", "req-004"],
  "createdAt": 1735513000000
}
```

**Query example**:
```javascript
// Get solution proposal from session
solution = wavesmith.store_get("SolutionProposal", session.solutionProposal)

// Access phases
solution.phases.forEach(phase => {
  console.log(`${phase.name}: ${phase.goal}`)
})
```

---

## Entity Relationships

```
DiscoverySession (root)
  ├─→ problemStatement: ProblemStatement (single reference)
  ├─→ artifacts: Artifact[] (array reference)
  ├─→ analysis: Analysis (single reference)
  └─→ solutionProposal: SolutionProposal (single reference)

Analysis
  ├─→ artifacts: Artifact[] (which artifacts analyzed)
  └─← derivedFrom (inverse): Requirement[] (requirements from this analysis)

SolutionProposal
  └─→ requirementsAddressed: Requirement[] (which requirements addressed)
```

---

## Typical Query Workflow

### Step 1: Get Session

```javascript
// Load schema first
wavesmith.schema_load("app-builder-discovery")

// Get session by ID (provided by user)
session = wavesmith.store_get("DiscoverySession", "sess-001")
```

### Step 2: Get Problem Statement

```javascript
problem = wavesmith.store_get("ProblemStatement", session.problemStatement)

console.log(problem.description)
console.log(problem.painPoints)
console.log(problem.desiredOutcome)
```

### Step 3: Get Analysis

```javascript
analysis = wavesmith.store_get("Analysis", session.analysis)

console.log(analysis.complexity)  // "medium"
console.log(analysis.findings)    // { documentTypes: [...], ... }
```

### Step 4: Get Requirements

```javascript
// Get all requirements
allRequirements = wavesmith.store_list("Requirement")

// Filter to this session's analysis
requirements = allRequirements.filter(r => r.derivedFrom === session.analysis)

// Or if you already have analysis object
requirements = allRequirements.filter(r => r.derivedFrom === analysis.id)

// Iterate through requirements
requirements.forEach(req => {
  console.log(`${req.id}: ${req.description}`)
  console.log(`  Category: ${req.category}`)
  console.log(`  Priority: ${req.priority}`)
  console.log(`  Acceptance Criteria:`)
  req.acceptanceCriteria.forEach(criterion => {
    console.log(`    - ${criterion}`)
  })
})
```

### Step 5: Get Solution Proposal

```javascript
solution = wavesmith.store_get("SolutionProposal", session.solutionProposal)

console.log(solution.summary)
console.log(solution.rationale)

solution.phases.forEach((phase, index) => {
  console.log(`\nPhase ${index + 1}: ${phase.name}`)
  console.log(`Goal: ${phase.goal}`)
  console.log(`Deliverables:`)
  phase.deliverables.forEach(d => console.log(`  - ${d}`))
})
```

---

## Complete Example Query

```javascript
// Load schema
wavesmith.schema_load("app-builder-discovery")

// Get session
const sessionId = "sess-001"  // From user input
const session = wavesmith.store_get("DiscoverySession", sessionId)

// Get problem
const problem = wavesmith.store_get("ProblemStatement", session.problemStatement)

// Get analysis
const analysis = wavesmith.store_get("Analysis", session.analysis)

// Get requirements
const allRequirements = wavesmith.store_list("Requirement")
const requirements = allRequirements.filter(r => r.derivedFrom === session.analysis)

// Get solution
const solution = wavesmith.store_get("SolutionProposal", session.solutionProposal)

// Now you have all discovery data to inform schema design:
console.log("Session:", session.name)
console.log("Problem:", problem.description)
console.log("Complexity:", analysis.complexity)
console.log("Findings:", analysis.findings)
console.log("Requirements:", requirements.length)
console.log("Solution phases:", solution.phases.length)
```

---

## What to Expect from Discovery Data

### Problem Statement
- Clear problem description
- 3-5 specific pain points
- Desired outcome statement
- Optional current approach

### Analysis
- Complexity assessment (low/medium/high)
- Complexity rationale explaining why
- Domain-specific findings object
- References to artifacts analyzed

### Requirements
- **Low complexity**: ~3 requirements
- **Medium complexity**: ~5 requirements
- **High complexity**: ~7+ requirements
- Each with:
  - Description
  - Domain-specific category
  - Priority level
  - 2-3 testable acceptance criteria

### Solution Proposal
- User-friendly summary
- Rationale explaining the approach
- **Low**: 1 phase
- **Medium**: 2-3 phases
- **High**: 3-6 phases
- Each phase with deliverables

---

## Domain Adaptation Patterns

### Findings Object

**Document processing**:
```json
"findings": {
  "documentTypes": [...],
  "workflowStates": [...],
  "reviewerRoles": [...]
}
```

**Data pipeline**:
```json
"findings": {
  "sourceSystem": "...",
  "recordTypes": [...],
  "transformations": [...],
  "recordVolume": "..."
}
```

**Web app**:
```json
"findings": {
  "coreFeatures": [...],
  "userActions": [...],
  "dataStructures": {...}
}
```

### Requirement Categories

**Document processing**: "extraction", "comparison", "matching", "preservation", "output"

**Data pipeline**: "extraction", "validation", "transformation", "loading", "error-handling"

**Web app**: "data-management", "organization", "sharing", "authentication", "persistence"

---

## Summary

**Key entities**:
1. DiscoverySession - Root orchestrator
2. ProblemStatement - The WHY
3. Artifact - Evidence/examples
4. Analysis - Findings and complexity
5. Requirement - What to build (with acceptance criteria)
6. SolutionProposal - How to build (phases and deliverables)

**Query pattern**:
```javascript
wavesmith.schema_load("app-builder-discovery")
→ store_get("DiscoverySession", sessionId)
→ store_get related entities
→ store_list("Requirement") + filter by derivedFrom
```

**What to use for schema design**:
- Requirements (descriptions, acceptance criteria, categories)
- Analysis findings (domain concepts, enums, patterns)
- Solution phases (workflow stages, entity lifecycles)

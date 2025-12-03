---
name: app-builder-implementation-spec
description: Transform validated discovery outputs and domain schemas into implementation-ready specifications with modules, interfaces, and tests. This skill should be used after app-builder-discovery and app-builder-schema-designer have completed to create Layer 2.5 specifications bridging domain models to executable code.
---

# App Builder Implementation Spec Creator

## Overview

This skill bridges the gap between **domain schemas** (Layer 2: entity models) and **executable code** (Layer 3: implementation). It produces **implementation specifications** (Layer 2.5) that define modules, interface contracts, and test specifications in a format ready for code generation.

**Core Philosophy**: Implementation planning first, code generation second. Think about black-box modules, function signatures, and test scenarios - then express them in structured specifications. Wavesmith stores the specs, not the implementation.

**When to use this skill**:
- After app-builder-discovery AND app-builder-schema-designer have completed
- When you have a validated domain schema with entities and relationships
- When you need to plan implementation before writing code
- When creating specifications for TDD-driven development

**What this skill does**:
- Extract modules and interfaces from discovery/schema phases
- Resolve algorithm ambiguities with explicit strategies
- Inherit and address gaps from schema phase coverage reports
- Generate test specifications in Given/When/Then format

**What this skill does NOT do**:
- Generate implementation code (that's Layer 3: code generators, stub creators)
- Make assumptions about module structure (always evidence-based from solution phases)
- Copy existing implementation patterns (each domain has unique needs)

## Getting Started

### Load Required Schemas

Before working with implementation specs, load the project and associated schemas with workspace parameters:

```javascript
// 1. Load app-builder-project schema (always default workspace)
wavesmith.schema_load("app-builder-project")

// 2. Find project by current workspace
workspace_path = process.cwd()
projects = wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: workspace_path }
})
project = projects[0]

// 3. Load discovery schema (core schema, no workspace)
wavesmith.schema_load("app-builder-discovery")

// 4. Load application (domain) schema with project workspace
// Construct absolute schema workspace path
schema_dir = path.join(project.workspacePath, project.schemaDir)
wavesmith.schema_load(project.domainSchemaId, {
  workspace: schema_dir
})

// 5. Load implementation-spec schema (core schema, no workspace)
wavesmith.schema_load("app-builder-implementation-spec")

// Now you can work with entities across all schemas
```

### Working with Multiple Schemas

This skill works with **four schemas** simultaneously:
1. **app-builder-project**: Orchestration layer tracking workspace paths and phase progress
2. **app-builder-discovery**: Discovery session and requirements (Layer 1)
3. **{domain-schema}**: Application entities like Template, Contract, etc. (Layer 2)
4. **app-builder-implementation-spec**: Module specifications, interface contracts, tests (Layer 2.5)

**Schema switching pattern**: Use explicit `schema_load()` calls to switch between schemas. The project schema provides workspace paths for entity operations.

**Workspace parameters**:
- **Schema loading**: Core schemas (app-builder-project, app-builder-discovery, app-builder-implementation-spec) load WITHOUT workspace. User domain schemas load WITH workspace.
- **Entity operations**: Use workspace parameters on entity CRUD operations to control where data is read from and written to. Impl-spec entities use `{workspace: spec_dir}` to isolate per-project data.

**Workspace Pattern Examples**:
```javascript
// ✅ CORRECT: Load core schemas without workspace
wavesmith.schema_load("app-builder-discovery")
wavesmith.schema_load("app-builder-implementation-spec")

// ✅ CORRECT: Load user domain schemas WITH workspace
wavesmith.schema_load(domain_name, {workspace: schema_dir})

// ✅ CORRECT: Read discovery entities (no workspace - from default location)
session = wavesmith.store_get("DiscoverySession", session_id)
requirements = wavesmith.store_list("Requirement")

// ✅ CORRECT: Write impl-spec entities WITH workspace (project-specific)
impl_session = wavesmith.store_create("ImplementationSession", {...}, {workspace: spec_dir})
modules = wavesmith.store_list("ModuleSpecification", {workspace: spec_dir})
wavesmith.store_update("InterfaceContract", id, {...}, {workspace: spec_dir})

// ✅ CORRECT: Update project entities (no workspace - default location)
wavesmith.store_update("AppBuilderProject", project.id, {...})

// ❌ WRONG: Don't add workspace to core schema loads
wavesmith.schema_load("app-builder-discovery", {workspace: discovery_dir})  // ❌

// ❌ WRONG: Don't forget workspace on impl-spec entity operations
wavesmith.store_create("ImplementationSession", {...})  // ❌ Data won't be in project workspace
```

### Understand the Implementation Spec Structure

Implementation spec outputs consist of four entity types:

- **ImplementationSession**: Root orchestrator tracking the overall implementation spec process
- **ModuleSpecification**: Defines black-box modules with purpose, category, and domain-specific details
- **InterfaceContract**: Defines function signatures with inputs, outputs, and algorithm strategies
- **TestSpecification**: Defines test scenarios in Given/When/Then format

Check the loaded schema via `wavesmith.schema_get("app-builder-implementation-spec")` for complete entity structure.

### Finding Project Workspaces

All workspace paths are managed by AppBuilderProject. Never construct paths manually - always use project fields:

**Project workspace paths**:
```javascript
// Load project first
wavesmith.schema_load("app-builder-project")
project = wavesmith.store_get("AppBuilderProject", project_id)

// Access workspace paths
discovery_workspace = project.workspacePath + "/" + project.discoveryDir
  // e.g., "/Users/me/my-project/.wavesmith/discovery"

schema_workspace = project.workspacePath + "/" + project.schemaDir
  // e.g., "/Users/me/my-project/.wavesmith/schemas"

spec_workspace = project.workspacePath + "/" + project.specDir
  // e.g., "/Users/me/my-project/.wavesmith/specs"

generated_workspace = project.workspacePath + "/" + project.generatedDir
  // e.g., "/Users/me/my-project/.wavesmith/generated"
```

**Absolute path construction for artifacts**:
```javascript
// When writing artifacts, use absolute paths from current directory
cwd = process.cwd()
spec_workspace_abs = path.join(cwd, project.specDir)
artifact_path = path.join(spec_workspace_abs, "modules", "module-name.md")

write_file(artifact_path, content)
```

**Why use project fields**: Eliminates path construction errors, ensures consistency across skills, enables workspace relocation.

## The 8-Phase Workflow

This skill follows a **conversational, autonomous workflow** with validation gates and ambiguity resolution. Be flexible - users may want to iterate or skip ahead if they have strong domain knowledge.

### Phase Overview

1. **Context Loading** - Load discovery session and application schema
2. **Module Design** - Extract module specifications from solution phases
3. **Interface Definition** - Define interface contracts with inputs/outputs/algorithms
4. **Ambiguity Scan** (NEW) - Identify undefined strategies and missing details
5. **Strategy Resolution Pass** (NEW) - Resolve ambiguities with explicit approaches
6. **Gap Inheritance Review** (NEW) - Address or defer schema phase gaps
7. **Test Specification** - Generate Given/When/Then test scenarios
8. **Review & Completion** - Validate traceability and generate artifacts

### Phase 1: Context Loading

**Goal**: Load AppBuilderProject, discovery session, and application schema to understand what needs to be implemented.

**Process**:

1. **Load AppBuilderProject** and get workspace paths:
   ```javascript
   // a. Load app-builder-project schema
   wavesmith.schema_load("app-builder-project")

   // b. Find project by workspace (current directory)
   workspace_path = process.cwd()
   projects = wavesmith.store_list("AppBuilderProject", {
     filter: { workspacePath: workspace_path }
   })

   if (projects.length === 0) {
     console.log("ERROR: No AppBuilderProject found. Run app-builder-discovery and app-builder-schema-designer first.")
     return
   }

   project = projects[0]

   // c. Extract workspace paths from project
   // Use project.workspacePath (absolute) with proper path.join()
   workspace_root = project.workspacePath
   discovery_dir = path.join(workspace_root, project.discoveryDir)
   schema_dir = path.join(workspace_root, project.schemaDir)
   spec_dir = path.join(workspace_root, project.specDir)

   // d. Get discovery session ID from project
   session_id = project.discoverySessionId
   app_schema_name = project.domainSchemaId  // Schema name from project

   if (!session_id || !app_schema_name) {
     console.log("ERROR: Project missing discoverySessionId or domainSchemaId. Run app-builder-schema-designer first.")
     return
   }
   ```

2. **Load discovery schema and entities** (no workspace - core schema):
   ```javascript
   // Switch to app-builder-discovery schema (core schema, no workspace)
   wavesmith.schema_load("app-builder-discovery")

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

3. **Load application schema** with workspace parameter:
   ```javascript
   // Load the domain schema with workspace
   wavesmith.schema_load(app_schema_name, {
     workspace: schema_dir
   })

   // Get schema to extract entity types
   app_schema = wavesmith.schema_get(app_schema_name)

   // Extract entity types from schema
   entity_types = Object.keys(app_schema.schema.$defs)
   // e.g., ["Template", "Contract", "ComparisonRun", "UpdateRun"]
   ```

4. **Load implementation-spec schema** and create/load session (core schema, entities in workspace):
   ```javascript
   // Switch to implementation-spec schema (core schema, no workspace)
   wavesmith.schema_load("app-builder-implementation-spec")

   // Check if implementation session already exists for this project
   // Use workspace parameter to load entities from project workspace
   existing_sessions = wavesmith.store_list("ImplementationSession", {
     workspace: spec_dir
   })
   impl_session = existing_sessions.find(s => s.project === project.id)

   if (!impl_session) {
     // Create new implementation session with workspace parameter
     impl_session = wavesmith.store_create("ImplementationSession", {
       id: generateUniqueId(),
       name: project.name,
       project: project.id,  // Link to project
       discoverySession: session_id,
       appSchemaName: app_schema_name,
       currentPhase: "planning",
       workspacePath: spec_dir,  // Use project.specDir
       createdAt: Date.now()
     }, {
       workspace: spec_dir  // Save to project workspace
     })

     // Update project with implementation session ID and phase
     wavesmith.schema_load("app-builder-project")
     wavesmith.store_update("AppBuilderProject", project.id, {
       implementationSessionId: impl_session.id,
       currentPhase: "implementation_spec",
       lastUpdatedAt: Date.now()
     })
     // No workspace parameter - project entities stay in default location

     // Switch back to impl-spec schema
     wavesmith.schema_load("app-builder-implementation-spec")
   }
   ```

5. **Present context summary**:
   ```
   "I've loaded the complete context for implementation spec creation:

   **Project**: {project.name}
   **Discovery Session**: {session.name}
   **Problem**: {problem.description}
   **Requirements**: {requirements.length} requirements identified
   **Solution Phases**: {solution.phases.length} phases proposed

   **Application Schema**: {app_schema_name}
   **Entity Types**: {entity_types.join(", ")}

   **Implementation Session**: {impl_session.id}
   **Workspace**: {spec_dir}

   Ready to design the module specifications?"
   ```

**Transition criteria**: User confirms context is loaded and is ready to proceed.

---

### Phase 2: Module Design

**Goal**: Extract module specifications from solution phases. Each module is a black box with a clear purpose, category (input/process/output), and domain-specific implementation details.

**Process**:

1. **Extract modules from solution phases**:

   **Pattern**: Each solution phase typically maps to one or more modules

   ```javascript
   solution.phases.forEach(phase => {
     // Phase example: "Document Structure Parser"
     // → Module: "document-parser" (input category)

     // Phase example: "Template Comparison Engine"
     // → Module: "comparison-engine" (process category)

     // Phase example: "Track Changes Generator"
     // → Module: "changes-generator" (output category)
   })
   ```

   **Heuristics**:
   - **Input modules**: Parse, load, extract, fetch, read
   - **Process modules**: Transform, compare, analyze, compute, validate
   - **Output modules**: Generate, export, render, format, write

2. **Populate module details** (opaque field - domain-adaptive):

   The `details` field is an opaque object that captures domain-specific implementation information:

   **Document Processing Domain**:
   ```javascript
   {
     algorithm: "DOCX parsing with python-docx",
     preserves: ["formatting", "styles", "pw-markers"],
     libraries: ["python-docx", "lxml"],
     pwMarkerPattern: "<<.*?>>",
     extractionStrategy: "recursive-descent"
   }
   ```

   **Data Pipeline Domain**:
   ```javascript
   {
     connector: "Salesforce REST API",
     authentication: "OAuth 2.0",
     polling: "5min",
     batching: "200 records per request",
     retryStrategy: "exponential-backoff"
   }
   ```

   **Web Application Domain**:
   ```javascript
   {
     framework: "React",
     stateManagement: "Context API",
     routing: "React Router",
     styling: "Tailwind CSS",
     componentPattern: "compound-components"
   }
   ```

3. **Create ModuleSpecification entities**:
   ```javascript
   modules = solution.phases.map(phase => {
     return wavesmith.store_create("ModuleSpecification", {
       id: generateUniqueId(),
       session: impl_session.id,
       name: deriveModuleName(phase.name),  // e.g., "template-parser"
       purpose: phase.description,
       category: inferCategory(phase.name),  // "input" | "process" | "output"
       details: extractDomainDetails(phase, analysis.findings, requirements),
       implementsRequirements: findRelatedRequirements(phase, requirements),
       createdAt: Date.now()
     }, {
       workspace: spec_dir
     })
   })
   ```

4. **Update implementation session phase**:
   ```javascript
   wavesmith.store_update("ImplementationSession", impl_session.id, {
     currentPhase: "module_design"
   }, {
     workspace: spec_dir
   })
   ```

5. **Generate workspace artifact** (modules/):
   ```javascript
   // Construct absolute path for artifact
   cwd = process.cwd()
   spec_workspace_abs = path.join(cwd, spec_dir)
   module_artifact_path = path.join(spec_workspace_abs, "modules", `${module.name}.md`)

   // Write module artifact
   module_content = `
   # Module Specifications

   ## ${module.name}

   **Purpose**: ${module.purpose}
   **Category**: ${module.category}
   **Implements**: ${module.implementsRequirements.map(r => r.id).join(", ")}

   ### Implementation Details

   ${JSON.stringify(module.details, null, 2)}

   ### Dependencies

   ${module.dependsOn.map(m => `- ${m.name}`).join("\n")}
   `

   write_file(module_artifact_path, module_content)
   ```

6. **Present module design** with summary:
   ```
   "I've designed {modules.length} module specifications:

   **Input Modules** ({count}):
   - {module.name}: {module.purpose}

   **Process Modules** ({count}):
   - {module.name}: {module.purpose}

   **Output Modules** ({count}):
   - {module.name}: {module.purpose}

   **Implementation Details**: Each module includes domain-specific details in the `details` field (algorithms, libraries, strategies).

   **Requirements Coverage**: {coverage_percentage}% of requirements are implemented by these modules.

   Would you like me to adjust any modules before defining interfaces?"
   ```

7. **Review gate - Request approval**:
   ```
   "Do these modules capture the implementation structure correctly?

   - Are module names clear and descriptive?
   - Should any modules be split or combined?
   - Are the categories (input/process/output) correct?
   - Any missing modules?

   Let me know if you'd like me to adjust anything before we define interfaces."
   ```

**Transition criteria**: User approves module design or requests adjustments. Iterate until approved.

---

### Phase 3: Interface Definition

**Goal**: Define interface contracts for each module - function signatures with inputs, outputs, algorithm strategies, and error handling.

**Process**:

1. **Generate interfaces for each module**:

   **Pattern**: Each module has 1-3 primary interfaces (functions)

   **Heuristics**:
   - Input modules: `parse_X`, `load_X`, `fetch_X`, `extract_X`
   - Process modules: `compare_X`, `analyze_X`, `transform_X`, `validate_X`
   - Output modules: `generate_X`, `export_X`, `render_X`, `format_X`

2. **Define inputs** (opaque field - references Layer 2 schema entities):
   ```javascript
   inputs: {
     template_path: {
       type: "string",
       description: "Path to DOCX file",
       required: true
     },
     options: {
       type: "object",
       properties: {
         extract_pw_markers: { type: "boolean", default: true }
       }
     }
   }
   ```

3. **Define outputs** (opaque field - references Layer 2 schema entities):
   ```javascript
   outputs: {
     type: "Template",  // References Layer 2 schema entity
     schemaReference: "contract-template-updater.Template",
     description: "Parsed template with sections and PW markers",
     structure: {
       id: "string",
       name: "string",
       sections: "Section[]",
       pwMarkers: "PWMarker[]"
     }
   }
   ```

4. **Define errors** (opaque field):
   ```javascript
   errors: {
     ParsingError: {
       when: "Invalid DOCX format or corrupted file",
       httpStatus: 400
     },
     FileNotFoundError: {
       when: "Template file does not exist",
       httpStatus: 404
     }
   }
   ```

5. **Define algorithm strategy**:
   ```javascript
   algorithmStrategy: "Parse DOCX using python-docx, extract sections recursively, identify PW markers using regex pattern, preserve formatting metadata"
   ```

6. **Create InterfaceContract entities**:
   ```javascript
   interfaces = modules.flatMap(module => {
     return generateInterfacesForModule(module).map(interface_spec => {
       return wavesmith.store_create("InterfaceContract", {
         id: generateUniqueId(),
         module: module.id,
         functionName: interface_spec.functionName,
         purpose: interface_spec.purpose,
         inputs: interface_spec.inputs,
         outputs: interface_spec.outputs,
         errors: interface_spec.errors,
         algorithmStrategy: interface_spec.algorithmStrategy,
         createdAt: Date.now()
       }, {
         workspace: spec_dir
       })
     })
   })
   ```

7. **Validate schema entity references**:
   ```javascript
   // Ensure domain schema is loaded with workspace before validation
   wavesmith.schema_load(app_schema_name, {
     workspace: schema_dir
   })

   // Get schema to extract current entity types
   app_schema = wavesmith.schema_get(app_schema_name)
   entity_types = Object.keys(app_schema.schema.$defs)

   // Check if output types exist in Layer 2 schema
   interfaces.forEach(interface => {
     if (interface.outputs.schemaReference) {
       entity_name = interface.outputs.schemaReference.split(".")[1]
       if (!entity_types.includes(entity_name)) {
         console.warn(`⚠️ Interface ${interface.functionName} references unknown entity: ${entity_name}`)
       }
     }
   })

   // Switch back to impl-spec schema after validation
   wavesmith.schema_load("app-builder-implementation-spec")
   ```

8. **Update implementation session phase**:
   ```javascript
   wavesmith.store_update("ImplementationSession", impl_session.id, {
     currentPhase: "interface_definition"
   }, {
     workspace: spec_dir
   })
   ```

9. **Generate workspace artifact** (interfaces/contracts.yaml):
   ```javascript
   // Construct absolute path for interfaces artifact
   cwd = process.cwd()
   spec_workspace_abs = path.join(cwd, spec_dir)
   interface_artifact_path = path.join(spec_workspace_abs, "interfaces", "contracts.yaml")

   // Build YAML content
   interfaces_yaml = `
   interfaces:
     - module: template-parser
       function: parse_template
       purpose: Parse DOCX template file
       inputs:
         template_path:
           type: string
           required: true
       outputs:
         type: Template
         schema: contract-template-updater.Template
       errors:
         - ParsingError: Invalid DOCX format
         - FileNotFoundError: Template not found
       algorithm: Parse DOCX using python-docx, extract sections
   `

   write_file(interface_artifact_path, interfaces_yaml)
   ```

10. **Present interface design**:
    ```
    "I've defined {interfaces.length} interface contracts across {modules.length} modules:

    {modules.map(m => `
    **${m.name}**:
    ${interfaces_for_module.map(i => `- ${i.functionName}: ${i.purpose}`).join("\n")}
    `).join("\n")}

    **Schema Entity References**: Interfaces reference Layer 2 entities ({referenced_entities.join(", ")})

    **Algorithm Strategies**: Each interface includes a high-level strategy description

    Would you like me to adjust any interfaces before defining tests?"
    ```

11. **Review gate - Request approval**:
    ```
    "Do these interface contracts look correct?

    - Are function names clear and follow conventions?
    - Do inputs/outputs reference the correct schema entities?
    - Are error cases covered?
    - Are algorithm strategies detailed enough?

    Let me know if you'd like changes, or we can proceed to test specification."
    ```

**Transition criteria**: User approves interface design or requests adjustments. Iterate until approved.

**Next phase**: ambiguity_scan

---

### Phase 4: Ambiguity Scan

**Goal**: Systematically review interface contracts to identify undefined implementation strategies, missing algorithmic details, and unspecified approaches that would block code generation.

**Process**:

#### 1. Review Interface Algorithm Strategies

For each interface contract created in Phase 3, analyze the `algorithmStrategy` field:

```javascript
// Load all interfaces for this session
interfaces = wavesmith.store_list("InterfaceContract", {
  workspace: spec_dir
})
session_interfaces = interfaces.filter(i => {
  module = wavesmith.store_get("ModuleSpecification", i.module, {
    workspace: spec_dir
  })
  return module.session === impl_session.id
})

// Analyze each interface
ambiguities = []
session_interfaces.forEach(interface => {
  detected_ambiguities = scan_for_ambiguities(interface)
  if (detected_ambiguities.length > 0) {
    ambiguities.push({
      interface: interface.functionName,
      module: interface.module,
      ambiguities: detected_ambiguities
    })
  }
})
```

#### 2. Apply Ambiguity Detection Patterns

**Pattern 1: Undefined Extraction Method**

Triggers when algorithm mentions extraction/parsing without specifying approach:
- ❌ "Extract data from document"
- ❌ "Parse content using pattern matching" (which patterns?)
- ❌ "Analyze text to identify entities" (what analysis?)
- ✅ "Extract using regex pattern `\\d{3}-\\d{2}-\\d{4}` for identifier format"

**Pattern 2: Unspecified Validation Logic**

Triggers when algorithm mentions validation without specifying rules:
- ❌ "Validate data completeness"
- ❌ "Check for errors"
- ❌ "Ensure data quality"
- ✅ "Validate: all required fields non-empty, email matches RFC 5322 format, date is future"

**Pattern 3: Missing Confidence/Score Formulas**

Triggers when algorithm mentions scoring/confidence without formula:
- ❌ "Calculate confidence score"
- ❌ "Determine match quality"
- ❌ "Assign priority value"
- ✅ "Confidence = 1.0 - (0.3 × missing_fields_ratio) - (0.2 × validation_errors_count / 10)"

**Pattern 4: Undefined Algorithm Logic**

Triggers when algorithm mentions complex logic without steps:
- ❌ "Resolve dependency relationships"
- ❌ "Merge conflicting data"
- ❌ "Determine optimal ordering"
- ✅ "Resolve dependencies: (1) check for cycles, (2) traverse parent chain, (3) merge properties with override precedence"

**Pattern 5: Ambiguous Technology Choice**

Triggers when multiple approaches are possible:
- ❌ "Extract data" (code-based? LLM? hybrid?)
- ❌ "Transform format" (library? manual? external service?)
- ❌ "Generate output" (template engine? programmatic? LLM?)
- ✅ "Extract using pure Python parsing (no LLM) with standard library"

#### 3. Create Ambiguity Report

For each detected ambiguity, document:

**Example 1: Extraction Method Ambiguity**
```
Interface: parse_document
Module: document-processor
Ambiguity Type: Undefined Extraction Method
Current Strategy: "Parse document to extract structured data"
Question: How do we actually extract the data?
Candidates:
  - Regex-based parsing (pure code)
  - LLM-based extraction (API calls)
  - Hybrid: code for structure, LLM for content
  - Library-specific (e.g., specialized parser library)
Missing Details:
  - Which parsing approach?
  - What patterns or prompts?
  - How handle errors?
```

**Example 2: Confidence Formula Ambiguity**
```
Interface: calculate_match_score
Module: matching-engine
Ambiguity Type: Missing Formula
Current Strategy: "Calculate confidence score based on match quality"
Question: What exact formula produces the confidence score?
Candidates:
  - Simple boolean (match = 1.0, no match = 0.0)
  - Weighted factors (similarity × 0.6 + completeness × 0.4)
  - Deduction model (start at 1.0, subtract penalties)
Missing Details:
  - Exact formula with coefficients
  - Which factors contribute?
  - Value ranges and bounds
```

**Example 3: Algorithm Logic Ambiguity**
```
Interface: resolve_dependencies
Module: dependency-resolver
Ambiguity Type: Undefined Algorithm
Current Strategy: "Resolve dependency relationships between items"
Question: What algorithm handles dependency resolution?
Candidates:
  - Topological sort
  - Recursive traversal with memoization
  - Iterative depth-first search
Missing Details:
  - How detect cycles?
  - What order for evaluation?
  - How handle missing dependencies?
```

#### 4. Categorize by Severity

**Critical Ambiguities** (blocks code generation):
- No algorithmic approach specified
- Multiple incompatible strategies possible
- Core business logic undefined

**High Ambiguities** (code generation possible but incomplete):
- Formula components missing
- Validation rules unspecified
- Error handling approach unclear

**Medium Ambiguities** (implementation details needed):
- Library/framework choice unclear
- Performance optimization strategy undefined
- Edge case handling ambiguous

#### 5. Present Ambiguity Summary

```
🔍 Ambiguity Scan Complete

Detected {ambiguities.length} ambiguous algorithm strategies across {unique_modules} modules:

**Critical Ambiguities** ({critical_count}):
1. {module.name}.{interface.functionName}
   - Ambiguity: {description}
   - Question: {question}
   - Impact: Code generation blocked - no clear approach

**High Ambiguities** ({high_count}):
2. {module.name}.{interface.functionName}
   - Ambiguity: {description}
   - Question: {question}
   - Impact: Code will compile but logic incomplete

**Medium Ambiguities** ({medium_count}):
3. {module.name}.{interface.functionName}
   - Ambiguity: {description}
   - Question: {question}
   - Impact: Implementation details needed

Proceeding to Strategy Resolution Pass to resolve these ambiguities...
```

#### 6. Update Implementation Session

```javascript
wavesmith.store_update("ImplementationSession", impl_session.id, {
  currentPhase: "ambiguity_scan",
  metadata: {
    ambiguities_detected: ambiguities.length,
    critical_count: critical_count,
    high_count: high_count,
    medium_count: medium_count
  }
}, {
  workspace: spec_dir
})
```

#### 7. Domain-Agnostic Ambiguity Examples

**Document Processing Domain:**
- Interface: `extract_metadata` → Ambiguity: "How extract metadata?" → Candidates: XML parsing, regex, LLM
- Interface: `calculate_similarity` → Ambiguity: "What similarity metric?" → Missing: Levenshtein? Cosine? Jaccard?

**Data Pipeline Domain:**
- Interface: `transform_records` → Ambiguity: "How transform?" → Candidates: SQL, streaming, batch processing
- Interface: `validate_schema` → Ambiguity: "What validation rules?" → Missing: Field types? Constraints? Ranges?

**Web Application Domain:**
- Interface: `render_component` → Ambiguity: "What rendering approach?" → Candidates: SSR, CSR, hydration
- Interface: `optimize_query` → Ambiguity: "What optimization?" → Missing: Caching? Indexing? Query rewrite?

**Automation Workflow Domain:**
- Interface: `schedule_task` → Ambiguity: "What scheduling algorithm?" → Candidates: FIFO, priority queue, deadline-based
- Interface: `retry_failed` → Ambiguity: "What retry strategy?" → Missing: Exponential backoff? Fixed delay? Max attempts?

**Anti-patterns to avoid:**

❌ Flagging every algorithm as ambiguous (be selective - focus on genuine gaps)
❌ Domain-specific examples only (show cross-domain patterns)
❌ Accepting vague strategies without probing (e.g., "process data" is too vague)
✅ Systematic pattern matching (detection criteria)
✅ Clear questions with candidate solutions
✅ Severity-based prioritization

**Transition criteria**: Ambiguity scan complete with categorized list of undefined strategies

**Next phase**: strategy_resolution_pass

---

### Phase 5: Strategy Resolution Pass

**Goal**: Autonomously resolve ambiguities identified in Phase 4 by selecting explicit implementation strategies, documenting decisions with rationale and consequences.

**Process**:

#### 1. Load Ambiguities from Phase 4

```javascript
// Retrieve ambiguities detected in Phase 4
ambiguities = impl_session.metadata.ambiguities || []

// Categorize for resolution priority
critical_ambiguities = ambiguities.filter(a => a.severity === "critical")
high_ambiguities = ambiguities.filter(a => a.severity === "high")
medium_ambiguities = ambiguities.filter(a => a.severity === "medium")

// Resolution order: Critical → High → Medium
resolution_order = [...critical_ambiguities, ...high_ambiguities, ...medium_ambiguities]
```

#### 2. Apply Resolution Decision Framework

For each ambiguity, select strategy using this decision framework:

**Decision Framework for Extraction/Analysis Ambiguities:**

| Discovery Mentioned | Default Strategy | Rationale |
|---------------------|------------------|-----------|
| LLMs, AI, ML, GPT | LLM-assisted extraction | Discovery explicitly required AI capabilities |
| Parsing, regex, patterns | Code-based extraction | Pure programming approach feasible |
| Nothing specific | Code-based extraction | **Default to code** unless infeasible |
| Hybrid/uncertain | Code-based with LLM fallback | Start simple, escalate if needed |

**Decision Framework for Validation/Confidence Ambiguities:**

| Acceptance Criteria Type | Formula Approach | Example |
|--------------------------|------------------|---------|
| Boolean (pass/fail) | Simple threshold | `valid = (errors === 0)` |
| Weighted factors | Linear combination | `score = 0.6×A + 0.4×B` |
| Deduction model | Start at 1.0, subtract penalties | `conf = 1.0 - (0.3×missing) - (0.2×errors)` |
| Multi-tier | Categorical ranges | `if score >= 0.9: "high" elif >= 0.7: "medium" else: "low"` |

**Decision Framework for Algorithm Logic Ambiguities:**

| Problem Type | Algorithm Pattern | When to Use |
|--------------|-------------------|-------------|
| Graph traversal | DFS/BFS/Topological Sort | Dependencies, relationships, hierarchies |
| Ordering/ranking | Sort with custom comparator | Priority, scheduling, relevance |
| Matching/pairing | Greedy, dynamic programming | Optimization, resource allocation |
| State management | State machine, workflow engine | Status transitions, lifecycle tracking |

#### 3. Resolve Extraction/Analysis Ambiguities

**Resolution Pattern: Extraction Method**

```javascript
// Example: Ambiguous extraction strategy
interface = wavesmith.store_get("InterfaceContract", ambiguity.interface_id, {
  workspace: spec_dir
})

// Check discovery for LLM mentions
discovery_analysis = wavesmith.store_get("Analysis", session.analysis)
solution = wavesmith.store_get("SolutionProposal", session.solutionProposal)

llm_mentioned = check_for_keywords(
  [discovery_analysis.findings, solution.rationale],
  ["LLM", "AI", "machine learning", "GPT", "neural", "model"]
)

// Make decision
if (llm_mentioned) {
  strategy = "LLM-assisted extraction using structured prompts"
  approach_details = {
    method: "LLM",
    library: "openai / anthropic API",
    prompt_template: "Extract {fields} from the following {data_type}: {content}",
    fallback: "Return null if extraction confidence < 0.7"
  }
  rationale = "Discovery analysis mentioned AI/LLM capabilities, indicating structured extraction beyond code patterns"
  consequences = "Higher accuracy for unstructured data; API costs ~$0.01-0.10 per request; requires API key management"
} else {
  strategy = "Code-based extraction using regex patterns and heuristics"
  approach_details = {
    method: "regex",
    patterns: {
      "email": "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
      "phone": "\\(\\d{3}\\)\\s?\\d{3}-\\d{4}",
      "date": "\\d{1,2}/\\d{1,2}/\\d{4}"
    },
    library: "standard library regex module",
    fallback: "Return empty string if pattern not found"
  }
  rationale = "Discovery requirements achievable with deterministic parsing - no LLM mentioned"
  consequences = "Zero API costs; fast execution; limited to structured patterns; may miss edge cases"
}

// Update interface with resolved strategy
updated_strategy = `${strategy}\n\nDetails:\n${JSON.stringify(approach_details, null, 2)}`
wavesmith.store_update("InterfaceContract", interface.id, {
  algorithmStrategy: updated_strategy
}, {
  workspace: spec_dir
})

// Log resolution
resolution_log.push({
  interface: interface.functionName,
  ambiguity: ambiguity.description,
  decision: strategy,
  rationale: rationale,
  consequences: consequences,
  approach_details: approach_details
})
```

#### 4. Resolve Validation/Confidence Ambiguities

**Resolution Pattern: Confidence Formula**

```javascript
// Example: Ambiguous confidence calculation
interface = wavesmith.store_get("InterfaceContract", ambiguity.interface_id, {
  workspace: spec_dir
})

// Identify contributing factors from requirements
requirements = find_related_requirements(interface)
acceptance_criteria = extract_acceptance_criteria(requirements)

// Extract measurable factors
factors = {
  "missing_fields": "Count of required fields that are empty/null",
  "validation_errors": "Count of validation rule violations",
  "format_issues": "Count of fields not matching expected format",
  "completeness_ratio": "Filled fields / total fields"
}

// Define formula (deduction model example)
formula = {
  base_score: 1.0,
  deductions: {
    missing_fields: 0.3,  // -0.3 for each missing required field
    validation_errors: 0.2,  // -0.2 for each validation error
    format_issues: 0.1  // -0.1 for each format mismatch
  },
  min_score: 0.0,
  calculation: "max(0.0, 1.0 - (0.3 × missing) - (0.2 × errors) - (0.1 × format))"
}

// Create pseudocode
pseudocode = `
def calculate_confidence(entity):
    score = 1.0

    # Deduct for missing required fields
    missing_count = count_missing_required(entity)
    score -= (0.3 * missing_count)

    # Deduct for validation errors
    error_count = len(entity.validation_errors)
    score -= (0.2 * error_count)

    # Deduct for format issues
    format_issues = count_format_mismatches(entity)
    score -= (0.1 * format_issues)

    # Clamp to [0.0, 1.0]
    return max(0.0, min(1.0, score))
`

// Update interface
wavesmith.store_update("InterfaceContract", interface.id, {
  algorithmStrategy: interface.algorithmStrategy + "\n\n" + pseudocode
}, {
  workspace: spec_dir
})

// Log resolution
resolution_log.push({
  interface: interface.functionName,
  ambiguity: "Confidence formula undefined",
  decision: "Deduction model with weighted penalties",
  rationale: "Requirements emphasize error detection and completeness validation",
  consequences: "Simple linear formula - may need tuning based on real data",
  formula: formula,
  pseudocode: pseudocode
})
```

#### 5. Resolve Algorithm Logic Ambiguities

**Resolution Pattern: Algorithm Logic**

```javascript
// Example: Ambiguous dependency resolution
interface = wavesmith.store_get("InterfaceContract", ambiguity.interface_id, {
  workspace: spec_dir
})

// Analyze problem characteristics
problem_analysis = {
  has_cycles: true,  // From requirements: "detect circular dependencies"
  has_ordering: true,  // Need evaluation order
  has_missing_refs: true  // Handle broken references
}

// Select algorithm
algorithm = "Modified topological sort with cycle detection"

// Define detailed logic
detailed_logic = `
Algorithm: Topological Sort with Cycle Detection

1. Build dependency graph:
   - Nodes: All items with dependencies field
   - Edges: item → dependency for each dependency reference

2. Detect cycles:
   - Run DFS with visited/visiting/visited states
   - If visiting node encountered during DFS → cycle detected
   - Collect cycle path for error reporting

3. Handle missing dependencies:
   - If dependency ID not found in store → broken reference
   - Add to brokenReferences array
   - Continue processing (treat as no dependency)

4. Topological sort:
   - Use Kahn's algorithm (iterative, easier to implement)
   - Start with nodes having no dependencies (in-degree = 0)
   - Process queue, decrement in-degrees, add newly zero nodes
   - Result: valid processing order

5. Return value:
   - Success: Ordered list of item IDs
   - Cycle detected: Raise CircularDependencyError with cycle path
   - Broken refs: Log warnings but continue

Pseudocode:
def resolve_dependencies(items):
    graph = build_graph(items)

    # Cycle detection
    cycles = detect_cycles_dfs(graph)
    if cycles:
        raise CircularDependencyError(cycles)

    # Handle missing
    broken = find_broken_references(graph, items)
    if broken:
        log_warning(f"Broken references: {broken}")

    # Topological sort
    sorted_ids = kahns_algorithm(graph)
    return sorted_ids

Time Complexity: O(V + E) where V = items, E = dependency edges
Space Complexity: O(V) for visited tracking
`

// Update interface
wavesmith.store_update("InterfaceContract", interface.id, {
  algorithmStrategy: detailed_logic
}, {
  workspace: spec_dir
})

// Log resolution
resolution_log.push({
  interface: interface.functionName,
  ambiguity: "Dependency resolution algorithm undefined",
  decision: "Topological sort with cycle detection (Kahn's algorithm)",
  rationale: "Requirements specify cycle detection and ordering - topological sort addresses both",
  consequences: "O(n) complexity; requires full graph in memory; fails fast on cycles",
  algorithm_details: detailed_logic
})
```

#### 6. Document Strategy Decisions

For each resolution, create decision record:

**Decision Record Template:**
```markdown
## Strategy Decision: {interface.functionName}

**Interface**: {module.name}.{interface.functionName}
**Ambiguity**: {original_ambiguity_description}

### Decision
{selected_strategy}

### Rationale
{why_this_approach}

### Discovery Evidence
{references_to_discovery_requirements_or_analysis}

### Approach Details
{technical_specifics}

### Consequences
**Benefits:**
- {positive_outcome_1}
- {positive_outcome_2}

**Trade-offs:**
- {limitation_or_cost_1}
- {limitation_or_cost_2}

**Risks:**
- {potential_issue_1}
- {mitigation_strategy}

### Alternative Considered
- **Option**: {alternative_approach}
- **Why not chosen**: {reason}
```

#### 7. Update Implementation Session

```javascript
wavesmith.store_update("ImplementationSession", impl_session.id, {
  currentPhase: "strategy_resolution",
  metadata: {
    ...impl_session.metadata,
    ambiguities_resolved: resolution_log.length,
    strategies_documented: resolution_log.length
  }
}, {
  workspace: spec_dir
})
```

#### 8. Present Resolution Summary

```
🔧 Strategy Resolution Complete

Resolved {resolution_log.length} ambiguities with explicit implementation strategies:

**Extraction/Analysis Decisions** ({extraction_count}):
1. {module}.{interface}
   - Decision: {strategy} (code-based/LLM)
   - Rationale: {brief_rationale}
   - Consequence: {key_tradeoff}

**Validation/Confidence Decisions** ({formula_count}):
2. {module}.{interface}
   - Decision: {formula_type}
   - Formula: {simplified_formula}
   - Consequence: {key_tradeoff}

**Algorithm Logic Decisions** ({algorithm_count}):
3. {module}.{interface}
   - Decision: {algorithm_name}
   - Complexity: {time_space_complexity}
   - Consequence: {key_tradeoff}

All interfaces now have concrete, implementable algorithm strategies.

Strategy decision log: {workspace}/strategies/decisions.md

Proceeding to Gap Inheritance Review...
```

#### 9. Generate Workspace Artifacts

```javascript
// Construct absolute path for strategies artifact
cwd = process.cwd()
spec_workspace_abs = path.join(cwd, spec_dir)
strategies_artifact_path = path.join(spec_workspace_abs, "strategies", "decisions.md")

// Build strategies content
strategies_content = `
# Implementation Strategy Decisions

Generated: ${new Date().toISOString()}
Session: ${session.name}

${resolution_log.map(r => decision_record_template(r)).join("\n\n---\n\n")}
`

write_file(strategies_artifact_path, strategies_content)
```

**Anti-patterns to avoid:**

❌ Choosing LLM by default (code-based is default unless discovery mentioned AI)
❌ Vague formulas ("calculate based on quality")
❌ Algorithm names without logic ("use topological sort" without pseudocode)
❌ Ignoring discovery evidence when making decisions
✅ Evidence-based decisions (reference discovery findings)
✅ Concrete formulas with coefficients
✅ Pseudocode or decision trees for complex logic
✅ Trade-off documentation (benefits AND consequences)

**Transition criteria**: All ambiguities resolved with documented strategies and rationale

**Next phase**: gap_inheritance_review

---

### Phase 6: Gap Inheritance Review

**Goal**: Load schema coverage report from Phase 7 of schema-designer skill and determine how implementation spec addresses (or defers) each schema gap.

**Process**:

#### 1. Load Schema Coverage Report

```javascript
// Get absolute path to schema workspace using project
cwd = process.cwd()
schema_workspace_abs = path.join(cwd, schema_dir)

// Try to read coverage report file from schema workspace
coverage_report_path = path.join(schema_workspace_abs, "schema-coverage-report.md")
coverage_report_content = read_file(coverage_report_path)

// OR query Wavesmith if coverage stored as entity
// coverage_reports = wavesmith.store_list("CoverageReport")
// coverage_report = coverage_reports.find(r => r.schemaId === app_schema_name)

if (!coverage_report_content && !coverage_report) {
  console.log("⚠️ No schema coverage report found at:", coverage_report_path)
  console.log("Skipping gap inheritance review - not all schemas may have reports")
  // Proceed without gap review
  return
}

// Parse coverage report to extract gaps
gaps = parse_coverage_gaps(coverage_report_content)
// Expected format: { requirement_id, description, gap_reason, status: "gap" | "partial" }

console.log(`Found ${gaps.length} schema gaps to review from:`, coverage_report_path)
```

#### 2. Categorize Schema Gaps

For each gap, determine if it's relevant to implementation spec:

**Gap Categories:**

| Gap Type | Impl Spec Responsibility | Action |
|----------|-------------------------|--------|
| **Data field missing** | Schema issue, not spec | Defer - note in documentation |
| **Validation logic undefined** | Spec defines logic | Address - add validation interface |
| **Workflow state missing** | Schema issue | Defer - OR add workflow module if critical |
| **Error handling absent** | Spec defines error strategy | Address - update error handling in interfaces |
| **Feature not modeled** | Depends on feature type | Evaluate case-by-case |

**Classification logic:**
```javascript
gaps.forEach(gap => {
  classification = classify_gap(gap)

  if (classification === "implementation_spec") {
    // Gap should be addressed in this phase
    addressable_gaps.push(gap)
  } else if (classification === "schema_structure") {
    // Gap is schema-level, defer to schema phase or post-implementation
    deferred_gaps.push(gap)
  } else {
    // Unclear - ask user
    unclear_gaps.push(gap)
  }
})
```

#### 3. Address Addressable Gaps

For gaps that implementation spec can resolve:

**Strategy A: Add Missing Interface**

```javascript
// Example: Schema has detectedGaps field but no detection logic specified
gap = {
  requirement: "req-005",
  description: "Detect missing items during processing",
  gap_reason: "Schema has ProcessingRun.detectedGaps field but no detection algorithm",
  schema_element: "ProcessingRun.detectedGaps"
}

// Create new interface to fill gap
new_interface = wavesmith.store_create("InterfaceContract", {
  id: generateUniqueId(),
  module: find_module_by_name("processing-engine").id,
  functionName: "detect_missing_items",
  purpose: "Identify expected items that were not found during processing",
  inputs: {
    expected_items: {
      type: "array",
      items: { type: "string" },
      description: "List of item IDs that should be present"
    },
    found_items: {
      type: "array",
      items: { type: "string" },
      description: "List of item IDs that were actually found"
    }
  },
  outputs: {
    type: "array",
    items: { type: "string" },
    schemaReference: "ProcessingRun.detectedGaps",
    description: "List of missing item IDs (expected but not found)"
  },
  errors: {},
  algorithmStrategy: `
Set difference algorithm:
1. Convert expected_items and found_items to sets
2. Compute set difference: missing = expected - found
3. Return missing as sorted array

Pseudocode:
def detect_missing_items(expected, found):
    expected_set = set(expected)
    found_set = set(found)
    missing = expected_set - found_set
    return sorted(list(missing))

Time: O(n + m), Space: O(n + m)
  `,
  createdAt: Date.now()
})

// Log gap resolution
gap_resolutions.push({
  gap: gap,
  action: "interface_added",
  interface: new_interface.functionName,
  rationale: "Schema defined storage field; implementation spec adds detection logic"
})
```

**Strategy B: Enhance Existing Interface**

```javascript
// Example: Schema has qualityScore field but existing interface lacks quality calculation
gap = {
  requirement: "req-006",
  description: "Track quality indicators for items",
  gap_reason: "Schema has ItemEntity.qualityScore but no calculation logic",
  schema_element: "ItemEntity.qualityScore"
}

// Find existing interface that should calculate quality
existing_interface = find_interface("process_item")

// Update with quality calculation logic
enhanced_strategy = existing_interface.algorithmStrategy + `

Quality Score Calculation (addresses gap from schema phase):
1. Base quality starts at 1.0
2. Deduct for data issues:
   - Missing required fields: -0.3 per field
   - Format errors: -0.2 per error
   - Validation warnings: -0.1 per warning
3. Clamp result to [0.0, 1.0]
4. Store in ItemEntity.qualityScore field

Pseudocode:
def calculate_quality_score(item):
    score = 1.0
    score -= 0.3 * count_missing_required(item)
    score -= 0.2 * len(item.validationErrors)
    score -= 0.1 * len(item.validationWarnings)
    return max(0.0, min(1.0, score))
`

wavesmith.store_update("InterfaceContract", existing_interface.id, {
  algorithmStrategy: enhanced_strategy,
  outputs: {
    ...existing_interface.outputs,
    qualityScore: {
      type: "number",
      minimum: 0.0,
      maximum: 1.0,
      schemaReference: "ItemEntity.qualityScore"
    }
  }
})

// Log gap resolution
gap_resolutions.push({
  gap: gap,
  action: "interface_enhanced",
  interface: existing_interface.functionName,
  rationale: "Extended existing processing interface to calculate quality score"
})
```

**Strategy C: Add Module**

```javascript
// Example: Schema has ReviewRecord entity but no review workflow module
gap = {
  requirement: "req-007",
  description: "Support human review workflow",
  gap_reason: "Schema has ReviewRecord entity but no review operations defined",
  schema_element: "ReviewRecord"
}

// Create new module for review workflow
review_module = wavesmith.store_create("ModuleSpecification", {
  id: generateUniqueId(),
  session: impl_session.id,
  name: "review-workflow",
  purpose: "Manage human review process for items requiring validation",
  category: "process",
  details: {
    handles: "Review assignment, status transitions, approval/rejection",
    integrates_with: "ItemEntity, ReviewRecord",
    workflow_states: ["pending_review", "in_review", "approved", "rejected"]
  },
  implementsRequirements: ["req-007"],
  createdAt: Date.now()
})

// Create interfaces for review module
review_interfaces = [
  {
    functionName: "create_review",
    purpose: "Initialize review for an item",
    inputs: { item_id: "string", reviewer_id: "string" },
    outputs: { type: "ReviewRecord" },
    algorithmStrategy: "Create ReviewRecord entity, set status to pending_review, link to item"
  },
  {
    functionName: "submit_review",
    purpose: "Submit review decision (approve/reject)",
    inputs: { review_id: "string", decision: "enum", notes: "string" },
    outputs: { type: "ReviewRecord" },
    algorithmStrategy: "Update ReviewRecord status, record decision and notes, timestamp reviewedAt"
  }
]

review_interfaces.forEach(spec => {
  wavesmith.store_create("InterfaceContract", {
    ...spec,
    module: review_module.id,
    createdAt: Date.now()
  })
})

// Log gap resolution
gap_resolutions.push({
  gap: gap,
  action: "module_added",
  module: review_module.name,
  interfaces: review_interfaces.length,
  rationale: "Schema defined ReviewRecord entity; implementation spec adds workflow module"
})
```

#### 4. Document Deferred Gaps

For gaps that implementation spec cannot or should not address:

**Deferral Reasons:**

| Reason | Example | Documentation |
|--------|---------|---------------|
| **Schema-level issue** | Missing entity/field in schema | "Gap requires schema change - defer to schema phase iteration" |
| **Post-implementation** | UI/UX workflow details | "UI implementation details deferred to frontend development" |
| **Out of scope** | External system integration | "Third-party API integration deferred to integration phase" |
| **Explicitly excluded** | User decision to skip feature | "Feature excluded per user request - documented in requirements" |

**Deferral Documentation:**
```javascript
deferred_gaps.forEach(gap => {
  deferral_log.push({
    gap: gap,
    deferral_reason: determine_deferral_reason(gap),
    impact: "Implementation will be incomplete for this requirement",
    mitigation: "Add to post-code-generation TODO list",
    revisit_phase: "schema_iteration" | "frontend_development" | "integration"
  })
})
```

#### 5. Update Gap Documentation

```javascript
// Construct absolute path for gap report artifact
cwd = process.cwd()
spec_workspace_abs = path.join(cwd, spec_dir)
gap_report_path = path.join(spec_workspace_abs, "gaps", "inheritance-report.md")

// Build gap report content
gap_report_content = `
# Gap Inheritance Report

**Session**: ${session.name}
**Schema**: ${app_schema_name}
**Generated**: ${new Date().toISOString()}

## Summary

- **Schema Gaps Identified**: ${gaps.length}
- **Addressed in Spec**: ${gap_resolutions.length}
- **Deferred**: ${deferred_gaps.length}
- **Unclear/Pending**: ${unclear_gaps.length}

## Gaps Addressed in Implementation Spec

${gap_resolutions.map(r => `
### ${r.gap.requirement}: ${r.gap.description}

**Schema Gap**: ${r.gap.gap_reason}
**Action Taken**: ${r.action}
**Implementation**: ${r.interface || r.module}
**Rationale**: ${r.rationale}
`).join("\n")}

## Gaps Deferred

${deferred_gaps.map(d => `
### ${d.gap.requirement}: ${d.gap.description}

**Schema Gap**: ${d.gap.gap_reason}
**Deferral Reason**: ${d.deferral_reason}
**Impact**: ${d.impact}
**Revisit In**: ${d.revisit_phase}
`).join("\n")}

## Coverage Summary

Implementation spec addresses **${gap_resolutions.length}/${gaps.length}** schema gaps (${coverage_percent}%).

Remaining gaps are deferred to:
- Schema iteration: ${count}
- Frontend development: ${count}
- Integration phase: ${count}
- Out of scope: ${count}
`

write_file(gap_report_path, gap_report_content)
```

#### 6. Update Implementation Session

```javascript
wavesmith.store_update("ImplementationSession", impl_session.id, {
  currentPhase: "gap_inheritance_review",
  metadata: {
    ...impl_session.metadata,
    schema_gaps_total: gaps.length,
    schema_gaps_addressed: gap_resolutions.length,
    schema_gaps_deferred: deferred_gaps.length
  }
}, {
  workspace: spec_dir
})
```

#### 7. Present Gap Review Summary

```
📋 Gap Inheritance Review Complete

Schema Coverage Report Analysis:
- **Schema Gaps Found**: {gaps.length}
- **Addressed in Spec**: {gap_resolutions.length} ({percent}%)
- **Deferred**: {deferred_gaps.length}

Actions Taken:
{gap_resolutions.map(r => `
✅ ${r.gap.requirement}: ${r.action}
   - ${r.interface || r.module}
   - ${r.rationale}
`).join("\n")}

Deferred Items:
{deferred_gaps.map(d => `
⏸️ ${d.gap.requirement}: ${d.deferral_reason}
   - Will revisit in: ${d.revisit_phase}
`).join("\n")}

Gap tracking: {workspace}/gaps/inheritance-report.md

{if gap_resolutions.length > 0}
Updated {modules_updated} modules and {interfaces_updated} interfaces to address schema gaps.
{endif}

Proceeding to Test Specification (Phase 7)...
```

#### 8. Domain-Agnostic Gap Examples

**Document Processing:**
- Schema gap: "OCR quality tracking modeled but no quality assessment logic"
- Spec action: Add `assess_ocr_quality()` interface to document-processor module

**Data Pipeline:**
- Schema gap: "Error retry modeled but no retry strategy defined"
- Spec action: Enhance `process_batch()` interface with exponential backoff retry logic

**Web Application:**
- Schema gap: "User session entity exists but no session management logic"
- Spec action: Add session-manager module with `create_session()`, `validate_session()`, `expire_session()` interfaces

**Automation Workflow:**
- Schema gap: "Task priority field exists but no prioritization algorithm"
- Spec action: Add `calculate_priority()` interface with weighted scoring formula

**Anti-patterns to avoid:**

❌ Ignoring schema coverage report (assuming schema is complete)
❌ Addressing ALL gaps (some are legitimately deferred)
❌ Adding features not in schema (stay aligned with schema)
❌ Skipping deferral documentation (gaps must be tracked)
✅ Load and parse coverage report systematically
✅ Categorize gaps (addressable vs deferred)
✅ Document why gaps are deferred
✅ Update interfaces/modules to fill addressable gaps

**Transition criteria**: All schema gaps reviewed and either addressed or explicitly deferred with documentation

**Next phase**: test_specification (Phase 7, renumbered from Phase 4)

---

### Phase 7: Test Specification

*Note: Phase numbering updated - formerly Phase 4*

**Goal**: Generate test specifications in Given/When/Then format that validate module behavior against requirements and acceptance criteria.

**Process**:

#### 1. Extract test scenarios from requirements

   ```javascript
   requirements.forEach(req => {
     if (req.acceptanceCriteria && req.acceptanceCriteria.length > 0) {
       // Generate test for each acceptance criterion
       req.acceptanceCriteria.forEach(criterion => {
         test_scenario = createTestFromCriterion(req, criterion)
       })
     }
   })
   ```

2. **Determine test type**:
   - **Unit tests**: Single module, single function
   - **Integration tests**: Multiple modules interacting
   - **Acceptance tests**: End-to-end scenario validating requirement

3. **Write Given/When/Then** (abstract strings, not code):

   **Given** (preconditions):
   ```javascript
   given: [
     "A valid DOCX template file exists at 'templates/sample.docx'",
     "The template contains 3 sections with PW markers",
     "The template has preserved formatting (bold, italic, styles)"
   ]
   ```

   **When** (action):
   ```javascript
   when: "parse_template is called with the template path"
   ```

   **Then** (expected outcomes):
   ```javascript
   then: [
     "A Template entity is returned with id and name populated",
     "The Template.sections array contains 3 Section entities",
     "Each section has extracted content and formatting metadata",
     "PW markers are identified and stored in Template.pwMarkers array",
     "No parsing errors are raised"
   ]
   ```

4. **Create TestSpecification entities**:
   ```javascript
   tests = requirements.flatMap(req => {
     return req.acceptanceCriteria.map((criterion, idx) => {
       return wavesmith.store_create("TestSpecification", {
         id: generateUniqueId(),
         module: findModuleForRequirement(req),
         scenario: `${req.id}: ${criterion.split(".")[0]}`,
         testType: inferTestType(req, criterion),
         given: extractGivenStatements(req, criterion, analysis),
         when: extractWhenStatement(req, criterion),
         then: extractThenStatements(req, criterion),
         validatesRequirement: req.id,
         validatesAcceptanceCriteria: criterion,
         createdAt: Date.now()
       }, {
         workspace: spec_dir
       })
     })
   })
   ```

5. **Update implementation session phase**:
   ```javascript
   wavesmith.store_update("ImplementationSession", impl_session.id, {
     currentPhase: "test_specification"
   }, {
     workspace: spec_dir
   })
   ```

6. **Generate workspace artifact** (tests/scenarios.md):
   ```javascript
   // Construct absolute path for test scenarios artifact
   cwd = process.cwd()
   spec_workspace_abs = path.join(cwd, spec_dir)
   test_artifact_path = path.join(spec_workspace_abs, "tests", "scenarios.md")

   // Build test scenarios content
   test_scenarios_content = `
   # Test Specifications

   ## ${test.scenario}

   **Type**: ${test.testType}
   **Module**: ${module.name}
   **Validates**: ${test.validatesRequirement}

   ### Given
   ${test.given.map(g => `- ${g}`).join("\n")}

   ### When
   ${test.when}

   ### Then
   ${test.then.map(t => `- ${t}`).join("\n")}
   `

   write_file(test_artifact_path, test_scenarios_content)
   ```

7. **Present test design**:
   ```
   "I've generated {tests.length} test specifications:

   **Unit Tests** ({count}): Single module validation
   **Integration Tests** ({count}): Multi-module interaction
   **Acceptance Tests** ({count}): End-to-end requirement validation

   **Requirements Coverage**: {coverage_count}/{requirements.length} requirements have test coverage

   **Test Format**: All tests use abstract Given/When/Then format (not executable code)

   Would you like me to adjust any tests before final review?"
   ```

8. **Review gate - Request approval**:
   ```
   "Do these test specifications look correct?

   - Are all requirements covered by tests?
   - Are Given/When/Then statements clear and testable?
   - Should any tests be split or combined?
   - Any missing edge cases?

   Let me know if you'd like changes, or we can proceed to final review."
   ```

**Transition criteria**: User approves test specifications or requests adjustments. Iterate until approved.

**Next phase**: review_and_completion (Phase 8)

---

### Phase 8: Review & Completion

*Note: Phase numbering updated - formerly Phase 5*

**Goal**: Validate completeness, generate final workspace artifacts, and mark implementation session complete.

**Process**:

1. **Validate traceability**:

   **Requirements-to-Modules traceability**:
   ```javascript
   requirements.forEach(req => {
     implementing_modules = modules.filter(m =>
       m.implementsRequirements.includes(req.id)
     )
     if (implementing_modules.length === 0) {
       console.warn(`⚠️ Requirement ${req.id} not implemented by any module`)
     }
   })
   ```

   **Modules-to-Interfaces traceability**:
   ```javascript
   modules.forEach(module => {
     module_interfaces = interfaces.filter(i => i.module === module.id)
     if (module_interfaces.length === 0) {
       console.warn(`⚠️ Module ${module.name} has no interface contracts`)
     }
   })
   ```

   **Modules-to-Tests traceability**:
   ```javascript
   modules.forEach(module => {
     module_tests = tests.filter(t => t.module === module.id)
     if (module_tests.length === 0) {
       console.warn(`⚠️ Module ${module.name} has no test specifications`)
     }
   })
   ```

2. **Generate traceability matrix**:

   **Format - Use formal table**:
   ```markdown
   | Requirement | Modules | Interfaces | Tests | Status |
   |-------------|---------|------------|-------|--------|
   | req-001: Parse templates | template-parser | parse_template | 3 tests | ✅ Complete |
   | req-002: Compare sections | comparison-engine | compare_sections, fuzzy_match | 5 tests | ✅ Complete |
   | req-003: Generate changes | changes-generator | generate_track_changes | 2 tests | ✅ Complete |
   ```

3. **Generate final workspace artifacts**:

   ```javascript
   // Construct absolute paths for final artifacts
   cwd = process.cwd()
   spec_workspace_abs = path.join(cwd, spec_dir)
   overview_path = path.join(spec_workspace_abs, "overview.md")
   architecture_diagram_path = path.join(spec_workspace_abs, "diagrams", "architecture.md")
   traceability_path = path.join(spec_workspace_abs, "traceability", "requirements-coverage.md")

   // Build overview content
   overview_content = `
   # Implementation Specification: ${session.name}

   ## Summary

   - **Modules**: ${modules.length}
   - **Interfaces**: ${interfaces.length}
   - **Tests**: ${tests.length}
   - **Requirements Coverage**: ${coverage_percentage}%

   ## Architecture

   See diagrams/architecture.md for module dependency diagram

   ## Traceability

   See traceability/requirements-coverage.md for complete matrix
   `

   // Build architecture diagram
   architecture_content = `
   # Module Architecture

   \`\`\`mermaid
   graph LR
     TemplateParser[template-parser] --> ComparisonEngine[comparison-engine]
     ContractParser[contract-parser] --> ComparisonEngine
     ComparisonEngine --> ChangesGenerator[changes-generator]
   \`\`\`
   `

   // Write all artifacts
   write_file(overview_path, overview_content)
   write_file(architecture_diagram_path, architecture_content)
   write_file(traceability_path, traceability_matrix_content)
   ```

4. **Update implementation session and project status**:
   ```javascript
   // Update implementation session
   wavesmith.store_update("ImplementationSession", impl_session.id, {
     currentPhase: "complete",
     completedAt: Date.now()
   }, {
     workspace: spec_dir
   })

   // Switch to project schema and update project status
   wavesmith.schema_load("app-builder-project")
   wavesmith.store_update("AppBuilderProject", project.id, {
     currentPhase: "implementation_spec_complete",
     lastUpdatedAt: Date.now()
   })
   // No workspace parameter - project entities stay in default location

   // Switch back to impl-spec schema for final summary
   wavesmith.schema_load("app-builder-implementation-spec")
   ```

5. **Present completion summary**:
   ```
   "✅ Implementation specification complete!

   **Session**: {impl_session.name}
   **Modules**: {modules.length} specifications
   **Interfaces**: {interfaces.length} contracts
   **Tests**: {tests.length} scenarios

   **Requirements Coverage**: {coverage_count}/{requirements.length} requirements ({coverage_percentage}%)

   **Workspace**: {impl_session.workspacePath}
   - overview.md (specification summary)
   - modules/ ({modules.length} module specs)
   - interfaces/contracts.yaml ({interfaces.length} interface contracts)
   - tests/scenarios.md ({tests.length} test scenarios)
   - diagrams/architecture.md (module dependency diagram)
   - traceability/requirements-coverage.md (full matrix)

   **Traceability**:
   {traceability_table}

   The implementation specification is now ready for code generation. You can:
   - Query entities via Wavesmith MCP (store.list, store.get)
   - Generate code stubs from interface contracts
   - Implement tests based on Given/When/Then scenarios
   - Use module specs as implementation guides

   Next steps: Start code implementation using these specifications."
   ```

**Transition criteria**: All validation passes, workspace artifacts generated, session marked complete.

---

## Conversational Patterns

### Tone and Style

- **Collaborative, not prescriptive**: "Does this module design look right?" not "This is the implementation plan"
- **Evidence-based**: "Solution phase 'Document Parser' suggests a template-parser module"
- **Autonomous when possible**: Load contexts, explore workspaces, validate references without waiting for approval
- **Visual when helpful**: Use diagrams, tables, or structured representations

### Question Patterns

**Phase 1 (Context Loading)**:
- "Which discovery session should I use to generate implementation specs?"
- "I've loaded discovery session {name} and schema {schema_name}. Ready to proceed?"

**Phase 2 (Module Design)**:
- "Solution phase '{phase}' suggests module '{module_name}'. Does this make sense?"
- "Should {module} be split into multiple modules, or is this the right granularity?"
- "Are the module categories (input/process/output) correct?"

**Phase 3 (Interface Definition)**:
- "Interface {function_name} references schema entity {entity}. Is this correct?"
- "Should this function return a single {entity} or an array?"
- "What error cases should this interface handle?"

**Phase 4 (Ambiguity Scan)**:
- "I've detected {count} ambiguous algorithm strategies. Should I proceed to resolve them?"
- "Interface {function_name} has ambiguous extraction method. Candidates are: code-based, LLM, hybrid. Discovery mentions {keywords}."
- "The confidence formula is undefined. Should I use deduction model or weighted factors?"

**Phase 5 (Strategy Resolution)**:
- "I'm defaulting to code-based extraction since discovery didn't mention LLMs. Does this make sense?"
- "I've selected topological sort for dependency resolution. Alternative was recursive traversal. Rationale: {reason}."
- "Strategy decisions documented. Would you like to review before proceeding?"

**Phase 6 (Gap Inheritance)**:
- "Schema coverage report shows {count} gaps. {addressable} can be addressed in implementation spec."
- "Schema gap: {description}. Should I add a new interface or enhance existing one?"
- "Gap {id} is schema-level. Deferring to post-implementation. Agreed?"

**Phase 7 (Test Specification)**:
- "Requirement {req_id} has {count} acceptance criteria. Should each be a separate test?"
- "Should this be a unit test (single module) or integration test (multiple modules)?"
- "Are these Given/When/Then statements clear and testable?"

**Phase 8 (Review)**:
- "Requirement {req_id} isn't covered by any module. Should I add one?"
- "Module {module_name} has no tests. Should I generate some?"

### Approval Requests

**End of Phase 2**:
```
"Do these modules capture the implementation structure correctly? Let me know if you'd like me to adjust anything before defining interfaces."
```

**End of Phase 3**:
```
"Do these interface contracts look correct? Let me know if you'd like changes, or we can proceed to ambiguity scanning."
```

**End of Phase 4 (Ambiguity Scan)**:
```
"I've identified {count} ambiguities across {modules} modules. Ready to proceed with strategy resolution?"
```

**End of Phase 5 (Strategy Resolution)**:
```
"All ambiguities resolved with documented strategies. Ready to proceed with gap inheritance review?"
```

**End of Phase 6 (Gap Inheritance)**:
```
"Schema gaps reviewed: {addressed} addressed, {deferred} deferred. Ready to proceed to test specification?"
```

**End of Phase 7 (Test Specification)**:
```
"Do these test specifications look correct? Let me know if you'd like changes, or we can proceed to final review."
```

**End of Phase 8 (Review & Completion)**:
```
"Implementation specification is complete. All requirements are covered, and all artifacts are generated. Ready to proceed to code implementation?"
```

---

## Domain Adaptation

This skill works across domains by using **opaque fields** in module specifications and interface contracts. Domain-specific details are captured without forcing a rigid structure.

### How it Adapts

**Document Processing Domain**:
- Modules: template-parser, comparison-engine, changes-generator
- Details: `{algorithm: "DOCX parsing", libraries: ["python-docx"], pwMarkerPattern: "<<.*?>>"}`
- Interfaces: parse_template → Template, compare_sections → MatchResult[]

**Data Pipeline Domain**:
- Modules: salesforce-connector, transformation-engine, bigquery-loader
- Details: `{connector: "Salesforce API", polling: "5min", batching: "200 records"}`
- Interfaces: fetch_contacts → Contact[], transform_data → TransformedRecord[]

**Web Application Domain**:
- Modules: component-renderer, state-manager, route-handler
- Details: `{framework: "React", stateManagement: "Context API", routing: "React Router"}`
- Interfaces: render_component → JSX, update_state → State

**Pattern**: The skill doesn't know these details ahead of time. It extracts them from solution phases, analysis findings, and requirements.

### Generic Transformation Logic

**Module extraction**:
1. Each solution phase becomes 1+ modules
2. Module names derived from phase names (kebab-case)
3. Category inferred from phase verbs (parse → input, transform → process, generate → output)

**Interface generation**:
1. Module category determines primary interfaces (input → parse_X, process → transform_X, output → generate_X)
2. Inputs/outputs reference Layer 2 schema entities (from loaded app schema)
3. Algorithm strategy extracted from phase descriptions

**Test generation**:
1. Each requirement with acceptance criteria becomes 1+ tests
2. Given statements extracted from requirement context
3. When statement derived from interface function name
4. Then statements extracted from acceptance criteria

See `references/transformation-patterns.md` for detailed algorithms.

---

## Common Pitfalls

### Pitfall 1: Not Loading Layer 2 Schema

**Wrong**: "I'll reference Template entity in the interface contract" (without loading schema)

**Right**: "Let me load the application schema first to verify Template entity exists"

**Why**: Interface contracts reference Layer 2 schema entities. Must validate they exist.

### Pitfall 2: Hard-Coding Domain Structure

**Wrong**: "All document systems need template-parser, comparison-engine, changes-generator modules"

**Right**: "Solution phases mention 'Parser', 'Comparison', 'Generator', so I'll create modules for those"

**Why**: Module names come from solution phases, not generic assumptions.

### Pitfall 3: Executable Code in Tests

**Wrong**: `given: ["template = load_docx('sample.docx')"]` (code)

**Right**: `given: ["A valid DOCX template file exists at 'templates/sample.docx'"]` (abstract)

**Why**: Test specs are abstract scenarios, not executable code.

### Pitfall 4: Leaving Algorithm Strategies Ambiguous

**Wrong**: `algorithmStrategy: "Extract data from document"` (vague)

**Right**: `algorithmStrategy: "Extract using regex patterns: email (\\b[A-Z...\\b), phone (\\d{3}-...). Return null if not found."`

**Why**: Ambiguous strategies block code generation. Phase 4-5 resolve ambiguities, but catch them during interface definition too.

### Pitfall 5: Skipping Traceability Validation

**Wrong**: "I've created all modules, interfaces, and tests. Done!"

**Right**: "Let me validate that all requirements are covered by modules and tests"

**Why**: Missing traceability means incomplete specification.

### Pitfall 6: Over-Specifying Implementation Details

**Wrong**: `details: {implementation: "Use pandas DataFrame with vectorized operations, cache results in Redis"}`

**Right**: `details: {algorithm: "Vectorized data transformation", caching: "Redis"}`

**Why**: Layer 2.5 is specification, not implementation. Stay abstract enough for flexibility.

---

## Resources

This skill includes reference materials covering architectural context, transformation patterns, and multi-domain examples.

### references/

**architectural-context.md**: Complete 4-layer system overview explaining how Layer 2.5 (implementation spec) fits between Layer 2 (schema) and Layer 3 (code). Includes rationale for this layer and integration patterns.

**transformation-patterns.md**: Detailed algorithms for module extraction from solution phases, interface generation from modules, and test generation from requirements. Generic patterns that work across domains.

**ambiguity-resolution-patterns.md**: Patterns for detecting and resolving common algorithm ambiguities across domains. Includes decision frameworks for extraction methods, validation formulas, and algorithm selection. Used in Phases 4-5.

**document-processing-example.md**: KPMG contract-template-updater case study showing complete Layer 2.5 specification for document processing domain.

**data-pipeline-example.md**: Hypothetical Salesforce-to-BigQuery sync showing implementation spec for data pipeline domain.

**webapp-example.md**: Hypothetical React component library showing implementation spec for web application domain.

Load these references when you need architectural context, transformation guidance, or domain-specific examples.

---

## Final Notes

**Success criteria**:
- Implementation session is complete (currentPhase: "complete")
- All modules have interface contracts
- All modules have test specifications
- All requirements are implemented by modules
- All schema entity references are validated
- Workspace artifacts are generated
- User confirms specification matches their understanding

**When in doubt**:
- Ask the user for clarification
- Validate schema entity references exist in Layer 2 schema
- Check traceability before marking complete
- Iterate based on feedback

**Remember**: This is **collaborative implementation planning**, not automated code generation. The user's domain expertise is essential for getting the specification right. The goal is a complete, traceable specification ready for TDD-driven implementation.

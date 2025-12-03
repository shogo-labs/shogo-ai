# Transformation Patterns

This document details the **generic algorithms** for transforming Layer 1 (Discovery) and Layer 2 (Schema) outputs into Layer 2.5 (Implementation Spec) entities.

All patterns are **domain-agnostic** and work across document processing, data pipelines, web applications, and other domains.

---

## Pattern 1: Module Extraction from Solution Phases

### Algorithm

```javascript
function extractModules(solutionProposal, analysis, requirements) {
  const modules = []

  solutionProposal.phases.forEach(phase => {
    // Step 1: Derive module name from phase name
    const moduleName = deriveModuleName(phase.name)

    // Step 2: Infer module category from phase verbs
    const category = inferCategory(phase.name, phase.description)

    // Step 3: Extract domain-specific details
    const details = extractDomainDetails(phase, analysis, requirements)

    // Step 4: Find related requirements
    const implementsRequirements = findRelatedRequirements(phase, requirements)

    // Step 5: Create module specification
    modules.push({
      id: generateUniqueId(),
      name: moduleName,
      purpose: phase.description,
      category: category,
      details: details,
      implementsRequirements: implementsRequirements,
      dependsOn: [],  // Populated later via dependency analysis
      createdAt: Date.now()
    })
  })

  // Step 6: Analyze dependencies between modules
  analyzeDependencies(modules)

  return modules
}
```

### Step 1: Derive Module Name

**Input**: Phase name (e.g., "Document Structure Parser")

**Output**: kebab-case module name (e.g., "document-parser")

```javascript
function deriveModuleName(phaseName) {
  // 1. Extract key nouns and verbs
  const tokens = tokenize(phaseName)  // ["Document", "Structure", "Parser"]

  // 2. Filter out common words
  const filtered = tokens.filter(t => !["Structure", "Engine", "System"].includes(t))

  // 3. Combine remaining tokens
  const combined = filtered.join("-").toLowerCase()

  return combined  // "document-parser"
}
```

**Heuristics**:
- Remove filler words: "Structure", "Engine", "System", "Component", "Module"
- Keep domain-specific nouns: "Document", "Template", "Contract", "Salesforce", "Component"
- Keep action verbs: "Parser", "Comparison", "Generator", "Transformer", "Renderer"

### Step 2: Infer Module Category

**Categories**: `"input"`, `"process"`, `"output"`

```javascript
function inferCategory(phaseName, phaseDescription) {
  const name = phaseName.toLowerCase()
  const desc = phaseDescription.toLowerCase()

  // Input patterns
  if (matchesAny(name, desc, INPUT_PATTERNS)) {
    return "input"
  }

  // Output patterns
  if (matchesAny(name, desc, OUTPUT_PATTERNS)) {
    return "output"
  }

  // Default to process
  return "process"
}

const INPUT_PATTERNS = [
  /\bparse/i, /\bload/i, /\bextract/i, /\bfetch/i, /\bread/i,
  /\bingest/i, /\bimport/i, /\bcollect/i, /\bconnect/i
]

const OUTPUT_PATTERNS = [
  /\bgenerate/i, /\bexport/i, /\brender/i, /\bformat/i, /\bwrite/i,
  /\bpublish/i, /\bsend/i, /\bproduce/i, /\bdisplay/i
]
```

**Examples**:
- "Document Structure **Parser**" → `"input"` (matches /parse/)
- "Template **Comparison** Engine" → `"process"` (no input/output patterns)
- "Track Changes **Generator**" → `"output"` (matches /generate/)

### Step 3: Extract Domain-Specific Details

**Goal**: Populate the opaque `details` field with domain-specific implementation information.

```javascript
function extractDomainDetails(phase, analysis, requirements) {
  const details = {}

  // 1. Extract from phase description
  details.algorithm = extractAlgorithm(phase.description)
  details.libraries = extractLibraries(phase.description, analysis.findings)
  details.strategies = extractStrategies(phase.description)

  // 2. Extract from analysis findings
  const domain = analysis.domain  // "document-processing", "data-pipeline", etc.

  if (domain === "document-processing") {
    details.preserves = analysis.findings.preservationRequirements || []
    details.formats = analysis.findings.supportedFormats || []
  } else if (domain === "data-pipeline") {
    details.connector = analysis.findings.sourceSystem || "unknown"
    details.authentication = analysis.findings.authMethod || "unknown"
  } else if (domain === "webapp") {
    details.framework = analysis.findings.frontend || "unknown"
    details.stateManagement = analysis.findings.stateManagement || "unknown"
  }

  // 3. Extract from related requirements
  const relatedReqs = requirements.filter(r =>
    phase.description.includes(r.description.split(" ")[0])
  )

  relatedReqs.forEach(req => {
    if (req.acceptanceCriteria) {
      details.constraints = extractConstraints(req.acceptanceCriteria)
    }
  })

  return details
}
```

**Pattern**: Start with generic fields (algorithm, libraries, strategies), then add domain-specific fields based on `analysis.domain`.

### Step 4: Find Related Requirements

```javascript
function findRelatedRequirements(phase, requirements) {
  const relatedReqs = []

  requirements.forEach(req => {
    // Match on keywords
    const phaseKeywords = extractKeywords(phase.name + " " + phase.description)
    const reqKeywords = extractKeywords(req.description)

    const overlap = intersection(phaseKeywords, reqKeywords)

    // If 2+ keywords match, consider related
    if (overlap.length >= 2) {
      relatedReqs.push(req.id)
    }
  })

  return relatedReqs
}
```

**Heuristics**:
- Extract nouns and verbs from both phase and requirement
- Compute keyword overlap
- Threshold: ≥2 matching keywords = related

### Step 6: Analyze Dependencies

```javascript
function analyzeDependencies(modules) {
  modules.forEach(moduleA => {
    modules.forEach(moduleB => {
      if (moduleA.id !== moduleB.id) {
        // Check if moduleA's output is moduleB's input
        if (isInputOutputPair(moduleA, moduleB)) {
          moduleB.dependsOn.push(moduleA.id)
        }
      }
    })
  })
}

function isInputOutputPair(moduleA, moduleB) {
  // If A is input category and B is process category → likely dependency
  if (moduleA.category === "input" && moduleB.category === "process") {
    return true
  }

  // If A is process category and B is output category → likely dependency
  if (moduleA.category === "process" && moduleB.category === "output") {
    return true
  }

  return false
}
```

---

## Pattern 2: Interface Generation from Modules

### Algorithm

```javascript
function generateInterfaces(module, appSchema) {
  const interfaces = []

  // Step 1: Determine primary interface names based on category
  const functionNames = deriveFunctionNames(module.name, module.category)

  functionNames.forEach(functionName => {
    // Step 2: Generate inputs
    const inputs = generateInputs(module, functionName)

    // Step 3: Generate outputs (referencing Layer 2 schema entities)
    const outputs = generateOutputs(module, functionName, appSchema)

    // Step 4: Generate errors
    const errors = generateErrors(module, functionName)

    // Step 5: Generate algorithm strategy
    const algorithmStrategy = generateAlgorithmStrategy(module, functionName)

    // Step 6: Create interface contract
    interfaces.push({
      id: generateUniqueId(),
      module: module.id,
      functionName: functionName,
      purpose: generatePurpose(module, functionName),
      inputs: inputs,
      outputs: outputs,
      errors: errors,
      algorithmStrategy: algorithmStrategy,
      createdAt: Date.now()
    })
  })

  return interfaces
}
```

### Step 1: Derive Function Names

**Pattern**: Function name = action verb + module noun

```javascript
function deriveFunctionNames(moduleName, category) {
  const functionNames = []

  if (category === "input") {
    // Input modules: parse_X, load_X, fetch_X, extract_X
    const verbs = ["parse", "load", "fetch", "extract", "read"]
    functionNames.push(selectVerb(verbs, moduleName) + "_" + getModuleNoun(moduleName))
  } else if (category === "process") {
    // Process modules: transform_X, compare_X, analyze_X, validate_X
    const verbs = ["transform", "compare", "analyze", "validate", "compute"]
    functionNames.push(selectVerb(verbs, moduleName) + "_" + getModuleNoun(moduleName))
  } else if (category === "output") {
    // Output modules: generate_X, export_X, render_X, format_X
    const verbs = ["generate", "export", "render", "format", "write"]
    functionNames.push(selectVerb(verbs, moduleName) + "_" + getModuleNoun(moduleName))
  }

  return functionNames
}

function selectVerb(verbs, moduleName) {
  // Select verb that already appears in module name, or default to first
  for (const verb of verbs) {
    if (moduleName.includes(verb)) {
      return verb
    }
  }
  return verbs[0]
}

function getModuleNoun(moduleName) {
  // Extract noun from module name (e.g., "template-parser" → "template")
  return moduleName.split("-")[0]
}
```

**Examples**:
- Module: "template-parser" (input) → Function: "parse_template"
- Module: "comparison-engine" (process) → Function: "compare_sections"
- Module: "changes-generator" (output) → Function: "generate_changes"

### Step 2: Generate Inputs

```javascript
function generateInputs(module, functionName) {
  const inputs = {}

  // Input modules typically take file paths or identifiers
  if (module.category === "input") {
    const noun = getModuleNoun(module.name)
    inputs[`${noun}_path`] = {
      type: "string",
      description: `Path to ${noun} file`,
      required: true
    }
  }

  // Process modules typically take entity IDs or data objects
  if (module.category === "process") {
    // Extract entity types from module.details or purpose
    const entityTypes = extractMentionedEntities(module.purpose)
    entityTypes.forEach(entity => {
      inputs[`${entity.toLowerCase()}_id`] = {
        type: "string",
        description: `ID of ${entity} entity`,
        required: true
      }
    })
  }

  // Output modules typically take entity IDs and output options
  if (module.category === "output") {
    inputs.data = {
      type: "object",
      description: "Data to be formatted/exported",
      required: true
    }
    inputs.options = {
      type: "object",
      description: "Output formatting options",
      required: false
    }
  }

  return inputs
}
```

### Step 3: Generate Outputs

**Key**: Outputs reference Layer 2 schema entities

```javascript
function generateOutputs(module, functionName, appSchema) {
  const outputs = {}

  // Extract entity types from app schema
  const entityTypes = Object.keys(appSchema.$defs)

  // Match function name or module purpose to entity types
  const matchedEntity = entityTypes.find(entity =>
    functionName.includes(entity.toLowerCase()) ||
    module.purpose.toLowerCase().includes(entity.toLowerCase())
  )

  if (matchedEntity) {
    outputs.type = matchedEntity
    outputs.schemaReference = `${appSchema.name}.${matchedEntity}`
    outputs.description = `${matchedEntity} entity`

    // Include entity structure from schema
    outputs.structure = extractEntityStructure(appSchema, matchedEntity)
  } else {
    // Fallback: generic object
    outputs.type = "object"
    outputs.description = "Result object"
  }

  return outputs
}

function extractEntityStructure(appSchema, entityName) {
  const entityDef = appSchema.$defs[entityName]
  const structure = {}

  Object.entries(entityDef.properties).forEach(([propName, propDef]) => {
    structure[propName] = propDef.type
    if (propDef.type === "array") {
      structure[propName] = `${propDef.items.type || "object"}[]`
    }
  })

  return structure
}
```

**Example**:
```javascript
// Module: "template-parser"
// App schema has: { Template: {...}, Contract: {...} }
// Function: "parse_template"
// Output:
{
  type: "Template",
  schemaReference: "contract-template-updater.Template",
  description: "Template entity",
  structure: {
    id: "string",
    name: "string",
    sections: "object[]",
    pwMarkers: "object[]"
  }
}
```

### Step 4: Generate Errors

```javascript
function generateErrors(module, functionName) {
  const errors = {}

  // Input modules: parsing/loading errors
  if (module.category === "input") {
    errors.ParsingError = {
      when: "Invalid file format or corrupted data",
      httpStatus: 400
    }
    errors.FileNotFoundError = {
      when: "File does not exist at specified path",
      httpStatus: 404
    }
  }

  // Process modules: validation/business logic errors
  if (module.category === "process") {
    errors.ValidationError = {
      when: "Input data fails validation constraints",
      httpStatus: 400
    }
    errors.ProcessingError = {
      when: "Processing logic encounters an error",
      httpStatus: 500
    }
  }

  // Output modules: generation/formatting errors
  if (module.category === "output") {
    errors.GenerationError = {
      when: "Output generation fails",
      httpStatus: 500
    }
    errors.InvalidFormatError = {
      when: "Requested output format is not supported",
      httpStatus: 400
    }
  }

  return errors
}
```

### Step 5: Generate Algorithm Strategy

```javascript
function generateAlgorithmStrategy(module, functionName) {
  let strategy = ""

  // Extract algorithm from module.details
  if (module.details.algorithm) {
    strategy += module.details.algorithm
  }

  // Add library information
  if (module.details.libraries && module.details.libraries.length > 0) {
    strategy += ` using ${module.details.libraries.join(", ")}`
  }

  // Add strategy information
  if (module.details.extractionStrategy) {
    strategy += `, ${module.details.extractionStrategy}`
  }

  // Add preservation requirements
  if (module.details.preserves && module.details.preserves.length > 0) {
    strategy += `, preserving ${module.details.preserves.join(", ")}`
  }

  return strategy || "Implementation strategy to be determined"
}
```

---

## Pattern 3: Test Generation from Requirements

### Algorithm

```javascript
function generateTests(requirements, modules, interfaces) {
  const tests = []

  requirements.forEach(req => {
    // Step 1: Find module(s) implementing this requirement
    const implementingModules = modules.filter(m =>
      m.implementsRequirements.includes(req.id)
    )

    if (implementingModules.length === 0) {
      console.warn(`Requirement ${req.id} not implemented by any module`)
      return
    }

    // Step 2: Generate tests for each acceptance criterion
    req.acceptanceCriteria.forEach((criterion, idx) => {
      // Step 3: Determine test type
      const testType = determineTestType(req, implementingModules)

      // Step 4: Generate Given/When/Then
      const givenStatements = generateGivenStatements(req, criterion)
      const whenStatement = generateWhenStatement(req, criterion, interfaces)
      const thenStatements = generateThenStatements(req, criterion)

      // Step 5: Create test specification
      tests.push({
        id: generateUniqueId(),
        module: implementingModules[0].id,  // Primary module
        scenario: `${req.id}: ${criterion.split(".")[0]}`,
        testType: testType,
        given: givenStatements,
        when: whenStatement,
        then: thenStatements,
        validatesRequirement: req.id,
        validatesAcceptanceCriteria: criterion,
        createdAt: Date.now()
      })
    })
  })

  return tests
}
```

### Step 3: Determine Test Type

```javascript
function determineTestType(requirement, implementingModules) {
  // If multiple modules implement this requirement → integration test
  if (implementingModules.length > 1) {
    return "integration"
  }

  // If requirement mentions end-to-end scenario → acceptance test
  if (isEndToEndScenario(requirement.description)) {
    return "acceptance"
  }

  // Default: unit test
  return "unit"
}

function isEndToEndScenario(description) {
  const patterns = [
    /\buser\b/i, /\bworkflow\b/i, /\bend-to-end\b/i,
    /\bscenario\b/i, /\bcomplete\b/i
  ]
  return patterns.some(p => p.test(description))
}
```

### Step 4: Generate Given Statements

**Goal**: Extract preconditions from requirement and criterion

```javascript
function generateGivenStatements(requirement, criterion) {
  const givenStatements = []

  // 1. Extract entities mentioned in requirement
  const entities = extractMentionedEntities(requirement.description)
  entities.forEach(entity => {
    givenStatements.push(`A valid ${entity} entity exists`)
  })

  // 2. Extract preconditions from criterion
  const preconditions = extractPreconditions(criterion)
  givenStatements.push(...preconditions)

  // 3. Extract context from requirement description
  if (requirement.description.includes("when")) {
    const context = requirement.description.split("when")[0].trim()
    givenStatements.push(context)
  }

  return givenStatements
}

function extractPreconditions(criterion) {
  const preconditions = []

  // Look for "if", "when", "given" keywords
  if (criterion.includes("if ")) {
    const precondition = criterion.split("if ")[1].split(",")[0].trim()
    preconditions.push(precondition)
  }

  // Look for "contains", "has", "with" patterns
  const patterns = [
    /contains (\d+) ([\w\s]+)/i,
    /has ([\w\s]+)/i,
    /with ([\w\s]+)/i
  ]

  patterns.forEach(pattern => {
    const match = criterion.match(pattern)
    if (match) {
      preconditions.push(match[0])
    }
  })

  return preconditions
}
```

### Step 5: Generate When Statement

**Goal**: Extract the action/trigger from criterion

```javascript
function generateWhenStatement(requirement, criterion, interfaces) {
  // 1. Find interface related to this requirement
  const relatedInterface = interfaces.find(i =>
    requirement.description.toLowerCase().includes(i.functionName.toLowerCase())
  )

  if (relatedInterface) {
    return `${relatedInterface.functionName} is called`
  }

  // 2. Extract action verb from criterion
  const actionVerbs = ["parse", "compare", "generate", "validate", "transform"]
  for (const verb of actionVerbs) {
    if (criterion.toLowerCase().includes(verb)) {
      return `${verb} operation is performed`
    }
  }

  // 3. Fallback: use requirement description
  return requirement.description.split(".")[0]
}
```

### Step 6: Generate Then Statements

**Goal**: Extract expected outcomes from criterion

```javascript
function generateThenStatements(requirement, criterion) {
  const thenStatements = []

  // 1. Extract "must" statements
  const mustStatements = criterion.split(/\bmust\b/i)
  mustStatements.slice(1).forEach(stmt => {
    thenStatements.push(stmt.trim())
  })

  // 2. Extract "should" statements
  const shouldStatements = criterion.split(/\bshould\b/i)
  shouldStatements.slice(1).forEach(stmt => {
    thenStatements.push(stmt.trim())
  })

  // 3. Extract "returns" statements
  if (criterion.includes("returns")) {
    const returns = criterion.split("returns")[1].trim()
    thenStatements.push(`Returns ${returns}`)
  }

  // 4. If no statements found, use criterion as-is
  if (thenStatements.length === 0) {
    thenStatements.push(criterion)
  }

  return thenStatements
}
```

---

## Pattern 4: Traceability Matrix Generation

### Algorithm

```javascript
function generateTraceabilityMatrix(requirements, modules, interfaces, tests) {
  const matrix = []

  requirements.forEach(req => {
    // Find modules implementing this requirement
    const implementingModules = modules.filter(m =>
      m.implementsRequirements.includes(req.id)
    )

    // Find interfaces for these modules
    const relatedInterfaces = interfaces.filter(i =>
      implementingModules.some(m => m.id === i.module)
    )

    // Find tests validating this requirement
    const validatingTests = tests.filter(t =>
      t.validatesRequirement === req.id
    )

    // Determine status
    const status = determineStatus(implementingModules, relatedInterfaces, validatingTests)

    matrix.push({
      requirement: req.id,
      description: req.description.split(".")[0],
      modules: implementingModules.map(m => m.name),
      interfaces: relatedInterfaces.map(i => i.functionName),
      tests: validatingTests.length,
      status: status
    })
  })

  return matrix
}

function determineStatus(modules, interfaces, tests) {
  if (modules.length === 0) return "❌ No modules"
  if (interfaces.length === 0) return "⚠️ No interfaces"
  if (tests.length === 0) return "⚠️ No tests"
  return "✅ Complete"
}
```

---

## Pattern 5: Workspace Artifact Generation

### Algorithm

```javascript
function generateWorkspaceArtifacts(implementationSession, modules, interfaces, tests, workspacePath) {
  // 1. Generate overview.md
  generateOverview(implementationSession, modules, interfaces, tests, workspacePath)

  // 2. Generate module specifications
  modules.forEach(module => {
    generateModuleSpec(module, workspacePath)
  })

  // 3. Generate interface contracts YAML
  generateInterfacesYAML(interfaces, workspacePath)

  // 4. Generate test scenarios
  generateTestScenarios(tests, workspacePath)

  // 5. Generate architecture diagram
  generateArchitectureDiagram(modules, workspacePath)

  // 6. Generate traceability matrix
  generateTraceabilityMatrix(requirements, modules, interfaces, tests, workspacePath)
}
```

### Overview Generation

```markdown
# Implementation Specification: {session.name}

## Summary

- **Modules**: {modules.length}
- **Interfaces**: {interfaces.length}
- **Tests**: {tests.length}
- **Requirements Coverage**: {coverage}%

## Module Overview

| Module | Category | Purpose | Interfaces | Tests |
|--------|----------|---------|------------|-------|
| {module.name} | {module.category} | {module.purpose} | {count} | {count} |

## Architecture

[Link to diagrams/architecture.md]

## Traceability

[Link to traceability/requirements-coverage.md]
```

---

## Common Transformation Challenges

### Challenge 1: Ambiguous Solution Phases

**Problem**: Phase name is too generic (e.g., "Processing Engine")

**Solution**:
1. Look at phase description for more specific terms
2. Check analysis.findings for domain context
3. If still ambiguous, use "data-processor" or "entity-processor"

### Challenge 2: Missing Acceptance Criteria

**Problem**: Requirement has no acceptance criteria

**Solution**:
1. Generate test from requirement description alone
2. Use "then" clause: "Requirement {req.id} is satisfied"
3. Flag for user review

### Challenge 3: Schema Entity Reference Ambiguity

**Problem**: Interface output could match multiple schema entities

**Solution**:
1. Prefer entity name that appears in module name
2. Check module.implementsRequirements for entity mentions
3. If still ambiguous, use first matched entity and warn user

### Challenge 4: Module Granularity

**Problem**: Unclear if phase should be 1 module or multiple modules

**Solution**:
1. Default: 1 phase = 1 module
2. If phase description has multiple distinct responsibilities, split
3. Heuristic: ≥3 distinct action verbs in description → consider splitting

---

## Summary

These transformation patterns provide **generic, domain-agnostic algorithms** for generating Layer 2.5 specifications from Layer 1 and Layer 2 outputs. Key principles:

1. **Evidence-based**: Extract from discovery outputs, never assume
2. **Opaque fields**: Use flexible details objects for domain-specific data
3. **Schema-aware**: Reference Layer 2 entities in interface contracts
4. **Traceability-first**: Maintain references across all layers
5. **Queryable by design**: Structure data for multiple consumers

These patterns have been tested across multiple domains (document processing, data pipelines, web apps) and refined based on real-world usage.

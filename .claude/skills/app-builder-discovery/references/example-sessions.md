# Discovery Session Examples

This document provides complete examples of discovery sessions across three complexity levels. Each shows the full conversation flow with actual Wavesmith entity creation patterns.

## Example 1: KPMG Tax Contracts (High Complexity)

### Phase 1: Problem Capture

**User**: "I have hundreds of tax form contract documents that need to be compared against templates to identify changes."

**Agent**: "I'd like to understand more about what makes this challenging. Can you tell me about the pain points with your current approach?"

**User**: "Manual comparison takes hours per contract. It's easy to miss small changes in wording, and the templates have complex conditional logic with PW_ styles that need to be preserved."

**Agent**: "What's your current method for comparison?"

**User**: "Manual comparison in Word using Track Changes. Very time-consuming and error-prone."

**Agent**: "What would success look like for you?"

**User**: "Automated comparison that highlights differences and identifies which template rules apply to which sections."

**Wavesmith operations**:

```javascript
// Create problem statement first
prob_id = wavesmith.store_create("ProblemStatement", {
  "id": "prob-001",
  "description": "We have hundreds of tax form contract documents that need to be compared against templates to identify changes",
  "painPoints": [
    "Manual comparison takes hours per contract",
    "Easy to miss small changes in wording",
    "Templates have complex conditional logic with PW_ styles"
  ],
  "currentApproach": "Manual comparison in Word using Track Changes",
  "desiredOutcome": "Automated comparison that highlights differences and identifies which template rules apply",
  "createdAt": 1730217600000
})

// Infer name and description from problem
inferred_name = "tax-contract-comparator"
inferred_description = "Automated comparison that highlights differences and identifies which template rules apply"

// Create session with name, description, and problem reference
session_id = wavesmith.store_create("DiscoverySession", {
  "id": "sess-kpmg-001",
  "name": inferred_name,
  "description": inferred_description,
  "currentPhase": "artifact_collection",
  "problemStatement": prob_id,
  "startedAt": 1730217600000,
  "lastUpdatedAt": 1730217600000
})
// Returns: {"ok": true, "id": "sess-kpmg-001"}

// Announce: "Starting discovery for: **Tax Contract Comparator**"
```

### Phase 2: Artifact Collection

**Agent**: "Do you have example templates and contracts I can analyze?"

**User**: "/Users/ryan/kpmg/T0123 - Information Reporting.docx"

**Agent**: "Setting up workspace at: `.schemas/app-builder-discovery/workspaces/tax-contract-comparator/`"

**Agent**: "Great! Are there more templates or example contracts you'd like to include?"

**User**: "/Users/ryan/kpmg/Contract_ClientA_2024.docx"

**Wavesmith operations**:

```javascript
// First artifact arrives - set up workspace
session = wavesmith.store_get("DiscoverySession", session_id)
workspace_path = "/absolute/path/.schemas/app-builder-discovery/workspaces/" + session.name

// Create workspace directory
// Execute: mkdir -p {workspace_path}/artifacts

// Update session with workspace path
wavesmith.store_update("DiscoverySession", session_id, {
  "workspacePath": workspace_path,
  "lastUpdatedAt": 1730217640000
})

// Template artifact - copy and create entity
source1 = "/Users/ryan/kpmg/T0123 - Information Reporting.docx"
workspace1 = workspace_path + "/artifacts/T0123 - Information Reporting.docx"
// Execute: cp "{source1}" "{workspace1}"

art1_id = wavesmith.store_create("Artifact", {
  "id": "art-001",
  "filename": "T0123 - Information Reporting.docx",
  "sourcePath": source1,
  "workspacePath": workspace1,
  "format": "docx",
  "sizeBytes": 487424,
  "tags": ["template", "2024", "pw-styles"],
  "notes": "2024 template with PW_ paragraph styles for conditional content",
  "uploadedAt": 1730217660000
})

// Contract artifact - copy and create entity
source2 = "/Users/ryan/kpmg/Contract_ClientA_2024.docx"
workspace2 = workspace_path + "/artifacts/Contract_ClientA_2024.docx"
// Execute: cp "{source2}" "{workspace2}"

art2_id = wavesmith.store_create("Artifact", {
  "id": "art-002",
  "filename": "Contract_ClientA_2024.docx",
  "sourcePath": source2,
  "workspacePath": workspace2,
  "format": "docx",
  "sizeBytes": 512000,
  "tags": ["contract", "client-a", "2024"],
  "uploadedAt": 1730217680000
})

// Update session
wavesmith.store_update("DiscoverySession", session_id, {
  "artifacts": ["art-001", "art-002"],
  "currentPhase": "analysis",
  "lastUpdatedAt": 1730217680000
})
```

### Phase 3: Analysis

**Agent internal analysis** (reads files):
- Template has 81 sections with hierarchical numbering
- Detected PW_Section_Required, PW_Snippet_Help, PW_Snippet_Content_A styles
- 104 snippet IDs (S00001, S00002, etc.)
- Rules have multiple option paths
- Contract structure matches template but wording differs

**Agent**: "I've analyzed the template. This is a high-complexity scenario. The template contains 81 sections with conditional content controlled by PW_ paragraph styles. I detected 104 snippet IDs that represent decision points, and rules have multiple option paths that need to be preserved during comparison."

**Wavesmith operations**:

```javascript
ana_id = wavesmith.store_create("Analysis", {
  "id": "ana-001",
  "artifacts": ["art-001", "art-002"],
  "findings": {
    "totalSections": 81,
    "documentStructure": {
      "headingLevels": 3,
      "topLevelSections": 15
    },
    "detectedPatterns": {
      "pwStyles": [
        "PW_Section_Required",
        "PW_Snippet_Help",
        "PW_Snippet_Content_A",
        "PW_Snippet_Content_B"
      ],
      "snippetIds": 104,
      "ruleStructure": "conditional-options"
    }
  },
  "complexity": "high",
  "complexityRationale": "Document contains conditional content with business rules embedded in paragraph formatting (PW_ styles). Rules have multiple option paths that need to be preserved and matched. This goes beyond simple text comparison to require understanding of document structure and rule logic.",
  "analyzedAt": 1730217720000
})

// Update session
wavesmith.store_update("DiscoverySession", session_id, {
  "analysis": ana_id,
  "currentPhase": "requirements",
  "lastUpdatedAt": 1730217720000
})
```

### Phase 4: Requirements Elicitation

**Agent**: "Based on the analysis, I can identify several requirements. Let me walk through what needs to be built..."

**Requirements derived from findings**:

1. Extract template structure with section hierarchy
2. Preserve PW_ paragraph style metadata
3. Extract contract sections
4. Match template sections to contract sections
5. Compare matched sections for differences
6. Identify which template rules apply
7. Generate comparison report

**Wavesmith operations**:

```javascript
// Requirement 1
req1_id = wavesmith.store_create("Requirement", {
  "id": "req-001",
  "description": "Extract template structure preserving section hierarchy (1, 1.1, 1.1.1)",
  "category": "extraction",
  "priority": "critical",
  "acceptanceCriteria": [
    "All sections extracted with correct nesting",
    "Section numbering preserved",
    "Heading text captured"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217780000
})

// Requirement 2
req2_id = wavesmith.store_create("Requirement", {
  "id": "req-002",
  "description": "Preserve PW_ paragraph style metadata (section type, snippet IDs, options)",
  "category": "preservation",
  "priority": "critical",
  "acceptanceCriteria": [
    "PW_Section_ styles captured with title",
    "PW_Snippet_Help styles captured with guidance text",
    "PW_Snippet_Content_ options linked to correct rules"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217800000
})

// Requirement 3
req3_id = wavesmith.store_create("Requirement", {
  "id": "req-003",
  "description": "Extract contract sections for comparison",
  "category": "extraction",
  "priority": "critical",
  "acceptanceCriteria": [
    "Contract sections extracted with hierarchy",
    "Clean text without formatting artifacts"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217820000
})

// Requirement 4
req4_id = wavesmith.store_create("Requirement", {
  "id": "req-004",
  "description": "Match template sections to contract sections",
  "category": "matching",
  "priority": "high",
  "acceptanceCriteria": [
    "Section-by-section alignment",
    "Handle section number variations",
    "Flag unmatched sections"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217840000
})

// Requirement 5
req5_id = wavesmith.store_create("Requirement", {
  "id": "req-005",
  "description": "Compare matched sections for textual differences",
  "category": "comparison",
  "priority": "high",
  "acceptanceCriteria": [
    "Word-level diff highlighting",
    "Ignore formatting-only changes",
    "Quantify similarity scores"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217860000
})

// Requirement 6
req6_id = wavesmith.store_create("Requirement", {
  "id": "req-006",
  "description": "Identify which template rules (PW_ content) apply to contract sections",
  "category": "rule-matching",
  "priority": "high",
  "acceptanceCriteria": [
    "Determine which PW_Snippet_Content option was selected",
    "Flag missing required content",
    "Highlight mismatched options"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217880000
})

// Requirement 7
req7_id = wavesmith.store_create("Requirement", {
  "id": "req-007",
  "description": "Generate comparison report with findings",
  "category": "reporting",
  "priority": "medium",
  "acceptanceCriteria": [
    "Section-by-section comparison results",
    "Difference highlights",
    "Rule application status",
    "Exportable format"
  ],
  "derivedFrom": "ana-001",
  "createdAt": 1730217900000
})
```

### Phase 5: Solution Proposal

**Agent**: "Here's what I propose we build..."

**Wavesmith operations**:

```javascript
sol_id = wavesmith.store_create("SolutionProposal", {
  "id": "sol-001",
  "summary": "A document processor that extracts template rules and compares them against contracts to identify differences",
  "rationale": "The templates have complex conditional content (PW_ styles) that needs to be preserved during extraction. A structured approach will ensure all rules and options are captured correctly, then matched against contract sections to highlight changes. The high complexity justifies a multi-phase implementation with separate parsers for templates and contracts, followed by a comparison engine.",
  "phases": [
    {
      "name": "Template Parser",
      "goal": "Extract template structure with PW_ metadata",
      "deliverables": [
        "Template sections with hierarchy",
        "PW_ style metadata (section types, snippet IDs)",
        "Rule options linked to correct sections"
      ],
      "estimatedTime": "~45 minutes"
    },
    {
      "name": "Contract Parser",
      "goal": "Extract contract sections for comparison",
      "deliverables": [
        "Contract sections with hierarchy",
        "Clean text for matching"
      ],
      "estimatedTime": "~20 minutes"
    },
    {
      "name": "Comparison Engine",
      "goal": "Match sections and identify differences",
      "deliverables": [
        "Section-by-section matches",
        "Difference highlights",
        "Rule application status"
      ],
      "estimatedTime": "~30 minutes"
    }
  ],
  "requirementsAddressed": [
    "req-001", "req-002", "req-003",
    "req-004", "req-005", "req-006", "req-007"
  ],
  "createdAt": 1730217940000
})

// Update session to approved
wavesmith.store_update("DiscoverySession", session_id, {
  "solutionProposal": sol_id,
  "currentPhase": "approved",
  "lastUpdatedAt": 1730217940000
})
```

---

## Example 2: Invoice Processing (Medium Complexity)

### Phase 1: Problem Capture

**User**: "I need to process vendor invoices to extract line items and validate against purchase orders."

**Agent**: "What challenges are you facing with invoice processing?"

**User**: "Manual data entry leads to errors. Invoice formats vary across vendors. Validation against POs is time-consuming."

**Agent**: "How long does processing a typical invoice take?"

**User**: "About 15-20 minutes per invoice, and we process hundreds per month."

**Agent**: "What would make this successful?"

**User**: "Automated extraction with validation that flags exceptions for review."

**Wavesmith operations**:

```javascript
prob_id = wavesmith.store_create("ProblemStatement", {
  "id": "prob-002",
  "description": "Process vendor invoices to extract line items and validate against purchase orders",
  "painPoints": [
    "Manual data entry errors",
    "Inconsistent invoice formats across vendors",
    "Time-consuming validation"
  ],
  "currentApproach": "Manual data entry into accounting system",
  "desiredOutcome": "Automated extraction and validation with exception flagging",
  "createdAt": 1730218000000
})

inferred_name = "invoice-processor"
inferred_description = "Automated extraction and validation with exception flagging"

session_id = wavesmith.store_create("DiscoverySession", {
  "id": "sess-invoice-001",
  "name": inferred_name,
  "description": inferred_description,
  "currentPhase": "artifact_collection",
  "problemStatement": prob_id,
  "startedAt": 1730218000000,
  "lastUpdatedAt": 1730218000000
})
```

### Phase 2: Artifact Collection

**User**: "/Users/accountant/invoices/VendorA_Invoice_001.pdf and /Users/accountant/po/PO_12345.pdf"

**Wavesmith operations**:

```javascript
// Set up workspace
session = wavesmith.store_get("DiscoverySession", session_id)
workspace_path = "/absolute/path/.schemas/app-builder-discovery/workspaces/" + session.name
// Execute: mkdir -p {workspace_path}/artifacts

wavesmith.store_update("DiscoverySession", session_id, {
  "workspacePath": workspace_path,
  "lastUpdatedAt": 1730218030000
})

// Copy and create artifacts
source1 = "/Users/accountant/invoices/VendorA_Invoice_001.pdf"
workspace1 = workspace_path + "/artifacts/VendorA_Invoice_001.pdf"
// Execute: cp "{source1}" "{workspace1}"

art1_id = wavesmith.store_create("Artifact", {
  "id": "art-003",
  "filename": "VendorA_Invoice_001.pdf",
  "sourcePath": source1,
  "workspacePath": workspace1,
  "format": "pdf",
  "sizeBytes": 256000,
  "tags": ["invoice", "vendor-a"],
  "uploadedAt": 1730218040000
})

source2 = "/Users/accountant/po/PO_12345.pdf"
workspace2 = workspace_path + "/artifacts/PO_12345.pdf"
// Execute: cp "{source2}" "{workspace2}"

art2_id = wavesmith.store_create("Artifact", {
  "id": "art-004",
  "filename": "PO_12345.pdf",
  "sourcePath": source2,
  "workspacePath": workspace2,
  "format": "pdf",
  "sizeBytes": 128000,
  "tags": ["purchase-order"],
  "uploadedAt": 1730218060000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "artifacts": ["art-003", "art-004"],
  "currentPhase": "analysis",
  "lastUpdatedAt": 1730218060000
})
```

### Phase 3: Analysis

**Agent internal analysis**:
- Invoice has 3 pages with 2 tables
- Detected fields: invoice#, date, vendor, total, tax, line items
- Structured data but no conditional logic
- PO has matching structure for validation

**Agent**: "This is medium complexity. The invoices have structured tables with calculable fields, but no conditional content. Validation rules will be needed but the data structure is straightforward."

**Wavesmith operations**:

```javascript
ana_id = wavesmith.store_create("Analysis", {
  "id": "ana-002",
  "artifacts": ["art-003", "art-004"],
  "findings": {
    "pageCount": 3,
    "tableCount": 2,
    "detectedFields": {
      "invoiceNumber": true,
      "date": true,
      "vendor": true,
      "total": true,
      "tax": true,
      "lineItems": true
    },
    "currency": "USD",
    "calculationRules": ["subtotal", "tax", "total"]
  },
  "complexity": "medium",
  "complexityRationale": "Structured data with tables and validation logic, but no conditional content or embedded business rules. Requires field extraction and calculation validation but follows predictable patterns.",
  "analyzedAt": 1730218100000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "analysis": ana_id,
  "currentPhase": "requirements",
  "lastUpdatedAt": 1730218100000
})
```

### Phase 4: Requirements (5 for medium complexity)

**Wavesmith operations**:

```javascript
// Requirements 1-5
req1_id = wavesmith.store_create("Requirement", {
  "id": "req-008",
  "description": "Extract invoice header fields (number, date, vendor, amounts)",
  "category": "extraction",
  "priority": "critical",
  "acceptanceCriteria": [
    "All header fields captured",
    "Date format normalized",
    "Currency handling"
  ],
  "derivedFrom": "ana-002",
  "createdAt": 1730218120000
})

req2_id = wavesmith.store_create("Requirement", {
  "id": "req-009",
  "description": "Extract line items from invoice tables",
  "category": "extraction",
  "priority": "critical",
  "acceptanceCriteria": [
    "All line items with quantities and prices",
    "Row-level data preserved"
  ],
  "derivedFrom": "ana-002",
  "createdAt": 1730218140000
})

req3_id = wavesmith.store_create("Requirement", {
  "id": "req-010",
  "description": "Validate calculations (subtotal, tax, total)",
  "category": "validation",
  "priority": "high",
  "acceptanceCriteria": [
    "Math verification",
    "Flag calculation errors"
  ],
  "derivedFrom": "ana-002",
  "createdAt": 1730218160000
})

req4_id = wavesmith.store_create("Requirement", {
  "id": "req-011",
  "description": "Match invoice line items against purchase order",
  "category": "matching",
  "priority": "high",
  "acceptanceCriteria": [
    "Item-by-item matching",
    "Quantity verification",
    "Price verification"
  ],
  "derivedFrom": "ana-002",
  "createdAt": 1730218180000
})

req5_id = wavesmith.store_create("Requirement", {
  "id": "req-012",
  "description": "Flag exceptions for review (mismatches, missing items, price differences)",
  "category": "validation",
  "priority": "high",
  "acceptanceCriteria": [
    "Exception types categorized",
    "Severity levels",
    "Exportable report"
  ],
  "derivedFrom": "ana-002",
  "createdAt": 1730218200000
})
```

### Phase 5: Solution Proposal

**Wavesmith operations**:

```javascript
sol_id = wavesmith.store_create("SolutionProposal", {
  "id": "sol-002",
  "summary": "An invoice processor that extracts data and validates against purchase orders",
  "rationale": "The medium complexity justifies a two-phase approach: extraction followed by validation. Structured tables make extraction straightforward, and validation rules are deterministic.",
  "phases": [
    {
      "name": "PDF Extraction",
      "goal": "Extract invoice data from PDF tables",
      "deliverables": [
        "Header fields extracted",
        "Line items extracted",
        "Calculations verified"
      ],
      "estimatedTime": "~30 minutes"
    },
    {
      "name": "Validation Engine",
      "goal": "Validate extracted data and flag exceptions",
      "deliverables": [
        "PO matching logic",
        "Exception detection",
        "Report generation"
      ],
      "estimatedTime": "~25 minutes"
    }
  ],
  "requirementsAddressed": [
    "req-008", "req-009", "req-010", "req-011", "req-012"
  ],
  "createdAt": 1730218240000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "solutionProposal": sol_id,
  "currentPhase": "approved",
  "lastUpdatedAt": 1730218240000
})
```

---

## Example 3: Email Templates (Low Complexity)

### Phase 1: Problem Capture

**User**: "I need to generate personalized marketing emails from templates."

**Agent**: "What's challenging about your current email process?"

**User**: "Manual copy-paste for each recipient. Easy to miss variables. No validation."

**Agent**: "How many emails do you typically send?"

**User**: "Hundreds per campaign, monthly."

**Agent**: "What would success look like?"

**User**: "Batch generation with automatic variable substitution from CSV."

**Wavesmith operations**:

```javascript
prob_id = wavesmith.store_create("ProblemStatement", {
  "id": "prob-003",
  "description": "Generate personalized marketing emails from templates with variable substitution",
  "painPoints": [
    "Manual copy-paste for each recipient",
    "Easy to miss variables",
    "No validation of variable values"
  ],
  "currentApproach": "Manual editing of template for each recipient",
  "desiredOutcome": "Batch email generation with automatic variable substitution",
  "createdAt": 1730218300000
})

inferred_name = "email-template-generator"
inferred_description = "Batch email generation with automatic variable substitution"

session_id = wavesmith.store_create("DiscoverySession", {
  "id": "sess-email-001",
  "name": inferred_name,
  "description": inferred_description,
  "currentPhase": "artifact_collection",
  "problemStatement": prob_id,
  "startedAt": 1730218300000,
  "lastUpdatedAt": 1730218300000
})
```

### Phase 2: Artifact Collection

**User**: "/Users/marketing/templates/welcome-email-template.txt and /Users/marketing/data/recipients.csv"

**Wavesmith operations**:

```javascript
// Set up workspace
session = wavesmith.store_get("DiscoverySession", session_id)
workspace_path = "/absolute/path/.schemas/app-builder-discovery/workspaces/" + session.name
// Execute: mkdir -p {workspace_path}/artifacts

wavesmith.store_update("DiscoverySession", session_id, {
  "workspacePath": workspace_path,
  "lastUpdatedAt": 1730218330000
})

// Copy and create artifacts
source1 = "/Users/marketing/templates/welcome-email-template.txt"
workspace1 = workspace_path + "/artifacts/welcome-email-template.txt"
// Execute: cp "{source1}" "{workspace1}"

art1_id = wavesmith.store_create("Artifact", {
  "id": "art-005",
  "filename": "welcome-email-template.txt",
  "sourcePath": source1,
  "workspacePath": workspace1,
  "format": "txt",
  "sizeBytes": 2048,
  "tags": ["template", "marketing"],
  "uploadedAt": 1730218340000
})

source2 = "/Users/marketing/data/recipients.csv"
workspace2 = workspace_path + "/artifacts/recipients.csv"
// Execute: cp "{source2}" "{workspace2}"

art2_id = wavesmith.store_create("Artifact", {
  "id": "art-006",
  "filename": "recipients.csv",
  "sourcePath": source2,
  "workspacePath": workspace2,
  "format": "csv",
  "sizeBytes": 8192,
  "tags": ["data"],
  "uploadedAt": 1730218360000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "artifacts": ["art-005", "art-006"],
  "currentPhase": "analysis",
  "lastUpdatedAt": 1730218360000
})
```

### Phase 3: Analysis

**Agent internal analysis**:
- Template has 42 lines with 8 variables: {{name}}, {{company}}, {{date}}, {{amount}}, {{link}}, {{unsubscribe}}, {{sender}}, {{title}}
- No conditional logic or branching
- Simple substitution pattern

**Agent**: "This is low complexity. Simple variable substitution with no conditional logic. The template uses {{variable}} syntax consistently."

**Wavesmith operations**:

```javascript
ana_id = wavesmith.store_create("Analysis", {
  "id": "ana-003",
  "artifacts": ["art-005", "art-006"],
  "findings": {
    "lineCount": 42,
    "variables": [
      "{{name}}",
      "{{company}}",
      "{{date}}",
      "{{amount}}",
      "{{link}}",
      "{{unsubscribe}}",
      "{{sender}}",
      "{{title}}"
    ],
    "variableCount": 8,
    "conditionalLogic": false
  },
  "complexity": "low",
  "complexityRationale": "Simple variable substitution with no conditional logic or complex formatting requirements. Linear process with predictable patterns.",
  "analyzedAt": 1730218400000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "analysis": ana_id,
  "currentPhase": "requirements",
  "lastUpdatedAt": 1730218400000
})
```

### Phase 4: Requirements (3 for low complexity)

**Wavesmith operations**:

```javascript
req1_id = wavesmith.store_create("Requirement", {
  "id": "req-013",
  "description": "Parse template and identify variables",
  "category": "substitution",
  "priority": "critical",
  "acceptanceCriteria": [
    "All {{variable}} patterns detected",
    "Variable names extracted"
  ],
  "derivedFrom": "ana-003",
  "createdAt": 1730218420000
})

req2_id = wavesmith.store_create("Requirement", {
  "id": "req-014",
  "description": "Substitute variables from CSV data",
  "category": "substitution",
  "priority": "critical",
  "acceptanceCriteria": [
    "Row-by-row processing",
    "All variables replaced",
    "Output generated per row"
  ],
  "derivedFrom": "ana-003",
  "createdAt": 1730218440000
})

req3_id = wavesmith.store_create("Requirement", {
  "id": "req-015",
  "description": "Handle missing values gracefully",
  "category": "validation",
  "priority": "medium",
  "acceptanceCriteria": [
    "Detect missing CSV columns",
    "Flag empty values",
    "Optional default values"
  ],
  "derivedFrom": "ana-003",
  "createdAt": 1730218460000
})
```

### Phase 5: Solution Proposal

**Wavesmith operations**:

```javascript
sol_id = wavesmith.store_create("SolutionProposal", {
  "id": "sol-003",
  "summary": "A template processor that substitutes variables from CSV data",
  "rationale": "The low complexity allows for a single-phase implementation. Simple variable substitution requires minimal error handling and no conditional logic.",
  "phases": [
    {
      "name": "Variable Substitution",
      "goal": "Generate personalized emails from template",
      "deliverables": [
        "Variable detection",
        "CSV data loading",
        "Batch email generation",
        "Missing value handling"
      ],
      "estimatedTime": "~15 minutes"
    }
  ],
  "requirementsAddressed": ["req-013", "req-014", "req-015"],
  "createdAt": 1730218500000
})

wavesmith.store_update("DiscoverySession", session_id, {
  "solutionProposal": sol_id,
  "currentPhase": "approved",
  "lastUpdatedAt": 1730218500000
})
```

---

## Patterns Across Examples

### Complexity Indicators

**Low → Medium → High progression**:
- **Structure**: Variables → Tables → Conditional logic
- **Processing**: Linear → Validation → Rule evaluation
- **Requirements**: 3 → 5 → 7 minimum
- **Phases**: 1 → 2 → 3 phases
- **Time estimate**: ~15 min → ~55 min → ~95 min

### Findings Object Variation

Notice how `findings` adapts to domain:
- **Documents**: sections, styles, snippets
- **Invoices**: tables, fields, calculations
- **Templates**: variables, lineCount

### Category Flexibility

Requirements use free-form categories matching the domain:
- **KPMG**: extraction, preservation, matching, comparison, rule-matching, reporting
- **Invoices**: extraction, validation, matching
- **Email**: substitution, validation

### User-Facing Language

Solution proposals use capabilities language:
- "Document processor that extracts" not "Pydantic parser"
- "Invoice processor that validates" not "PDF extraction pipeline"
- "Template processor that substitutes" not "Variable interpolation engine"

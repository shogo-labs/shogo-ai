# Complexity Assessment Guide

This guide provides detailed patterns for recognizing low, medium, and high complexity across different problem domains.

## Complexity Framework

Complexity is determined by **logic and rules**, not just size or technical difficulty:

- **Low**: Linear processes, simple patterns, no conditional logic
- **Medium**: Structured data with validation rules, no conditional content selection
- **High**: Conditional logic, business rules embedded in structure, multiple decision paths

## Low Complexity Patterns

### Characteristics

- **Simple substitution** - Replace placeholders with values
- **Linear processing** - One path through the logic
- **No branching** - Same steps for all inputs
- **Predictable output** - Structure doesn't change based on input

### Recognition Signals

**In documents**:
- `{{variable}}` or `{placeholder}` patterns
- No if/then/else logic
- Same structure for all instances
- Simple formatting

**In data**:
- Flat structures (no nested relationships)
- Direct field mappings
- No calculated dependencies
- Single table or list

**In workflows**:
- Step 1 → Step 2 → Step 3 (always)
- No decision points
- Same actions for all cases

### Examples Across Domains

**Document Processing - Email Templates**:
```
Subject: Welcome {{name}}!

Hi {{name}},

Thanks for joining {{company}}. Your account is ready.

Click here: {{link}}

Best,
{{sender}}
```
**Why low**: Simple variable substitution, no conditional content, same template structure for everyone.

**Data Processing - Contact List Export**:
```
Input: Database with name, email, phone
Process: Export to CSV
Output: CSV file with same fields
```
**Why low**: Direct field mapping, no transformations, no validation rules.

**Web App - Basic CRUD**:
```
Features: Create todo, Read todos, Update todo, Delete todo
Logic: Simple database operations
No: Auth, filtering, relationships
```
**Why low**: Standard patterns, no business logic, predictable operations.

### Requirement Count

**Minimum 3 requirements** for low complexity.

Typical categories:
- Parse/detect patterns
- Perform main operation (substitute, extract, create)
- Handle edge cases (missing values, empty input)

## Medium Complexity Patterns

### Characteristics

- **Structured data** - Tables, nested objects, arrays
- **Validation rules** - Calculations must match, fields required
- **Transformations** - Data shape changes
- **No conditional selection** - Same fields/structure for all, but with validation

### Recognition Signals

**In documents**:
- Tables with calculable fields
- Required vs optional sections (but all sections present)
- Format variations (but same logical structure)
- Data extraction with validation

**In data**:
- Nested relationships (parent-child)
- Calculated fields (subtotal, tax, total)
- Referential integrity
- Multiple related tables

**In workflows**:
- Validation gates
- Error handling
- Data quality checks
- Transformation steps

### Examples Across Domains

**Document Processing - Invoice Extraction**:
```
Invoice has:
- Header: invoice#, date, vendor, total
- Line items table: item, quantity, price, subtotal
- Footer: subtotal, tax (calculated), total (calculated)

Validation needed:
- Line subtotals = quantity * price
- Total subtotal matches sum of line subtotals
- Tax calculation correct
- Grand total = subtotal + tax
```
**Why medium**: Structured tables with validation rules, but no conditional content. All invoices have same structure.

**Data Pipeline - Salesforce to BigQuery**:
```
Extract: 47 Salesforce objects
Transform:
- Flatten nested relationships
- Convert types (Salesforce → BigQuery)
- Handle custom fields
Load: BigQuery tables
Validate: Referential integrity maintained
```
**Why medium**: Complex transformations and validations, but deterministic. No conditional logic about which data to sync.

**Web App - Expense Tracker**:
```
Features:
- User auth
- CRUD expenses
- Category filtering
- Budget tracking (calculations)
- CSV export

Validation:
- Amount > 0
- Date valid
- Category from list
- Budget calculations correct
```
**Why medium**: Structured data with validation and calculations, but no complex conditional flows.

### Requirement Count

**Minimum 5 requirements** for medium complexity.

Typical categories:
- Extract/parse structured data
- Transform/normalize
- Validate calculations
- Validate relationships
- Handle exceptions/errors

### Distinguishing Medium from High

**Medium has validation rules, High has decision rules**:

**Medium**: "Check if total = subtotal + tax" (validation)
**High**: "If payment_type = 'net30' then show different content" (conditional selection)

**Medium**: All invoices have same structure, validate the numbers
**High**: Different invoice types show different sections

## High Complexity Patterns

### Characteristics

- **Conditional logic** - If/then/else in content or structure
- **Business rules** - Multiple option paths based on conditions
- **State machines** - Different flows based on state
- **Embedded rules** - Logic hidden in structure (like PW_ styles)

### Recognition Signals

**In documents**:
- Conditional sections (appear/disappear based on rules)
- Multiple option paths (select A or B or C)
- Business logic in formatting (styles indicate rules)
- Complex decision trees

**In data**:
- Workflow states with transitions
- Approval chains
- Dynamic schemas (structure changes based on type)
- Rule engines

**In workflows**:
- Multi-path decision trees
- State-dependent logic
- Complex approval flows
- Dynamic behavior based on context

### Examples Across Domains

**Document Processing - KPMG Tax Contracts**:
```
Template structure:
Section 1.2.3: Information Reporting
  PW_Section_Required: "This section applies to..."
  PW_Snippet_Help: S00042
    Rule: "Include if client has foreign accounts"
  PW_Snippet_Content_A: Option A text (for domestic only)
  PW_Snippet_Content_B: Option B text (for foreign accounts)
  PW_Snippet_Content_C: Option C text (for both)

Contract must:
- Determine which option was selected (A/B/C)
- Validate that selection matches client situation
- Compare against template's rule logic
```
**Why high**: Conditional content selection based on business rules. Different contracts show different options. Rules embedded in paragraph styles. Multiple decision paths.

**Data Pipeline - Multi-Tenant SaaS**:
```
Each tenant has:
- Different feature flags
- Custom fields (varies by tenant)
- Different workflows (approval chains vary)
- Conditional data sync (only sync if feature enabled)

Pipeline must:
- Detect which features are enabled
- Sync only relevant data per tenant
- Handle tenant-specific transformations
- Apply tenant-specific validation rules
```
**Why high**: Conditional logic about what to sync, not just how. Structure changes based on tenant configuration.

**Web App - Loan Application**:
```
Application flow varies by:
- Loan type (personal, business, mortgage)
- Credit score range (different approval paths)
- Income verification method (W2, 1099, self-employed)

Each path has:
- Different required documents
- Different approval workflow
- Different calculation rules
- Different review steps
```
**Why high**: Multiple conditional paths through the application. Different logic based on loan type and applicant profile. Complex state machine.

### Requirement Count

**Minimum 7 requirements** for high complexity.

Typical categories:
- Extract structure/data
- Preserve conditional logic/rules
- Detect which path/option was taken
- Validate rule application
- Handle multiple option paths
- Compare/match with rules
- Report findings

### Distinguishing High from Medium

**Key question**: "Does the structure or logic change based on conditions?"

**Medium**: Structure is fixed, validate the data
- All invoices have same fields
- All expenses follow same rules
- All contacts have same attributes

**High**: Structure/content varies based on rules
- Contract sections appear/disappear based on client situation
- Workflow steps vary based on loan type
- Document content selected from multiple options

## Cross-Domain Pattern Recognition

### Document Processing Complexity

| Level | Pattern | Example |
|-------|---------|---------|
| Low | Variable substitution | Email merge |
| Medium | Structured extraction + validation | Invoice parsing |
| High | Conditional content + rule logic | Tax document comparison |

### Data Pipeline Complexity

| Level | Pattern | Example |
|-------|---------|---------|
| Low | Direct mapping | Contact export |
| Medium | Transform + validate relationships | Salesforce → BigQuery |
| High | Conditional sync + dynamic schema | Multi-tenant SaaS |

### Web App Complexity

| Level | Pattern | Example |
|-------|---------|---------|
| Low | Basic CRUD | Todo list |
| Medium | CRUD + validation + calculations | Expense tracker |
| High | Multi-path workflows + state machine | Loan application |

## Edge Cases and Gray Areas

### "But it has a lot of fields!" (Size ≠ Complexity)

**Not automatically high complexity**:
- 50 invoice fields (medium if all validated, no conditional logic)
- 100 database columns (medium if referential integrity needed)
- Large document (low if just variable substitution)

**Size pushes up complexity when**:
- More fields → more conditional paths (high)
- More columns → more complex relationships (medium to high)
- Larger docs → more business rules (potentially high)

### "But it requires ML/AI!" (Technical sophistication ≠ Complexity)

**Using complex tech doesn't mean high complexity**:
- OCR to extract invoice (still medium - structured validation)
- NLP to categorize emails (could be low - simple classification)
- ML to predict expense category (still medium - no conditional logic)

**Tech signals complexity when**:
- ML model output drives conditional logic (high)
- AI determines which workflow path to take (high)
- Multiple models chained with decision points (high)

### When in Doubt

**Ask**: "If I change one input value, does the structure/logic change?"

**Low**: No - same process, different data values
**Medium**: No - same structure, different calculations
**High**: Yes - different content/workflow based on conditions

## Rationale Writing Guide

When documenting complexity determination, explain:

1. **What was found**: Specific patterns detected
2. **Why that matters**: How it maps to low/medium/high
3. **What it means for implementation**: Implications

### Good Rationale Examples

**Low complexity**:
> "Simple variable substitution with no conditional logic or complex formatting requirements. All templates follow the same structure with 8 variables that need to be replaced from CSV data. Linear process with predictable patterns."

**Medium complexity**:
> "Structured data with tables and validation logic, but no conditional content or embedded business rules. Invoices contain calculable fields (subtotal, tax, total) that require validation. Extraction is deterministic but requires referential integrity checking against purchase orders."

**High complexity**:
> "Document contains conditional content with business rules embedded in paragraph formatting (PW_ styles). Rules have multiple option paths (A/B/C) that need to be preserved and matched. Different contracts select different options based on client situation, requiring logic to determine which path was taken. This goes beyond simple text comparison to require understanding of document structure and rule logic."

### Poor Rationale Examples

❌ "This is complex because there's a lot of data"
✅ "This is high complexity because data structure changes based on tenant feature flags"

❌ "Medium complexity - needs validation"
✅ "Medium complexity - structured tables with calculable fields requiring validation, but no conditional content selection"

❌ "High because PW_ styles"
✅ "High because PW_ styles encode conditional business rules that control which content appears, creating multiple decision paths"

## Complexity Migration

Sometimes complexity changes during analysis:

**Initial assessment** → **Revised after artifact analysis**:

**Example 1**:
- Thought: "Just extract invoice fields" (seems low)
- Found: Tables with nested line items + validation rules (actually medium)

**Example 2**:
- Thought: "Parse tax document" (seems medium)
- Found: PW_ styles controlling conditional content (actually high)

**Example 3**:
- Thought: "Complex multi-step workflow" (seems high)
- Found: Linear steps with no branching (actually low)

**When complexity changes**:
1. Update Analysis entity with revised complexity
2. Revise complexityRationale explaining what changed understanding
3. Adjust requirement count (3→5→7 as needed)
4. Update solution proposal phases accordingly

---

Use this guide to make consistent, well-reasoned complexity assessments across any problem domain.

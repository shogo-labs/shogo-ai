# Edge Case Probing Framework

Lightweight framework for discovering edge cases during discovery. Use for complex features to surface failure modes and boundary conditions.

## When to Use

- Feature has external integrations
- Feature handles user-supplied data
- Feature involves state synchronization
- Requirements seem incomplete

## Five Categories

Select 2-3 most relevant to the feature:

### 1. Missing/Incomplete Data

**Probe questions:**
- What if expected items are missing from a collection?
- What if required fields are empty or null?
- What if references to related entities don't exist?
- What if configuration data is missing?

**Example requirement:** "Handle missing parent references gracefully with clear error messages"

### 2. Validation Failures

**Probe questions:**
- What if data fails validation rules?
- What if cross-field constraints are violated?
- What if business rules are breached?

**Example requirement:** "Validate entity relationships before persisting"

### 3. Error Handling & Recovery

**Probe questions:**
- What if external service calls fail?
- What if persistence operations fail?
- What if operations are interrupted mid-process?

**Example requirement:** "Provide clear error messages when operations fail"

### 4. Scale & Performance

**Probe questions:**
- What if the collection contains 10x/100x expected items?
- What if individual items are larger than expected?
- What if concurrent operations exceed capacity?

**Example requirement:** "Support pagination for large collections"

### 5. Data Quality

**Probe questions:**
- What if input data is malformed?
- What if data contains inconsistencies?
- What if timestamps are in unexpected formats?

**Example requirement:** "Normalize input data before processing"

## Category Selection by Archetype

| Archetype | Recommended Categories |
|-----------|----------------------|
| **Service** | Error Handling, Scale, Data Quality |
| **Domain** | Missing Data, Validation, Scale |
| **Infrastructure** | Error Handling, Scale |
| **Hybrid** | Error Handling, Missing Data, Scale |

## Output

For each edge case identified:
1. Create a Requirement entity with priority `should` or `could`
2. Link it to the session
3. Note it as derived from edge-case probing

**Target:** 1-2 additional requirements per category probed.

## Anti-patterns

**Too generic:**
- "Handle all errors" (what errors?)
- "Support large datasets" (how large?)

**Too specific:**
- "Handle exactly 1000 items" (arbitrary)
- "Retry exactly 3 times" (implementation detail)

**Out of scope:**
- "Support multi-language" (feature expansion)
- "Add analytics" (different feature)

## Integration with Discovery

Edge case probing happens in Phase 3 (Derive Requirements):

1. Extract core requirements from intent
2. Select 2-3 edge case categories based on archetype
3. Probe each category briefly (2-3 questions)
4. Add 1-2 requirements for critical edge cases
5. Continue to Phase 4 (Validate & Handoff)

Keep it lightweight - this is discovery, not exhaustive analysis.

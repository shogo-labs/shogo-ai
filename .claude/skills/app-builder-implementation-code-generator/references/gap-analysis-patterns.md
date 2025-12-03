# Gap Analysis Patterns

Reference documentation for identifying and categorizing gaps between requirements/schema/code in generated projects.

## Overview

Gap analysis (Phase 7) identifies features specified in discovery/schema/spec phases but not fully implemented in generated code. This document provides algorithms, categorization criteria, and domain-agnostic examples for systematic gap identification.

---

## Gap Types

### 1. Requirement-to-Code Gaps

**Definition**: Requirements that have no corresponding function stub or test case.

**Detection Algorithm**:
```python
def detect_requirement_gaps(requirements, functions, tests):
    gaps = []
    for req in requirements:
        has_function = any(f.requirement_id == req.id for f in functions)
        has_test = any(t.requirement_id == req.id for t in tests)

        if not has_function and not has_test:
            gaps.append({
                'requirement': req,
                'status': 'completely_missing',
                'severity': 'P0_critical',
                'reason': 'No stub or test generated'
            })
        elif has_function and not has_test:
            gaps.append({
                'requirement': req,
                'status': 'stub_present_no_test',
                'severity': 'P1_high',
                'reason': 'Function stub exists but no test case'
            })
        elif not has_function and has_test:
            gaps.append({
                'requirement': req,
                'status': 'test_present_no_stub',
                'severity': 'P1_high',
                'reason': 'Test case exists but no function stub'
            })
    return gaps
```

**Examples**:

**Document Processing**:
- Requirement: "Extract text with OCR quality tracking"
- Gap: OCR quality validation interface defined in spec, no stub generated
- Reason: Quality tracking logic deferred as application-specific

**Data Pipeline**:
- Requirement: "Retry failed batch processing with exponential backoff"
- Gap: Retry logic mentioned in requirements, no retry interface in spec
- Reason: Batch processing module missing retry strategy

**Web Application**:
- Requirement: "Rate limit API requests per user"
- Gap: Rate limiting requirement exists, no rate limiter module in code
- Reason: Rate limiting not modeled in schema phase

### 2. Schema-to-Code Gaps

**Definition**: Schema entities or fields that are not represented in generated code or never used in function signatures.

**Detection Algorithm**:
```python
def detect_schema_gaps(schema, models, functions):
    gaps = []

    # Check entities
    for entity_name in schema['$defs'].keys():
        has_model = any(m.name == entity_name for m in models)
        if not has_model:
            gaps.append({
                'entity': entity_name,
                'status': 'entity_not_modeled',
                'severity': 'P1_high',
                'reason': f'Schema entity {entity_name} not in generated models'
            })
        else:
            # Check if entity is used in function signatures
            model = next(m for m in models if m.name == entity_name)
            is_used = any(
                entity_name in f.inputs or entity_name in f.outputs
                for f in functions
            )
            if not is_used:
                gaps.append({
                    'entity': entity_name,
                    'status': 'entity_unused',
                    'severity': 'P2_medium',
                    'reason': f'Model exists but never used in function signatures'
                })

    # Check error states
    for entity_name, entity_def in schema['$defs'].items():
        if 'error' in entity_name.lower() or 'exception' in entity_name.lower():
            is_handled = any(
                entity_name in f.errors
                for f in functions
            )
            if not is_handled:
                gaps.append({
                    'entity': entity_name,
                    'status': 'error_not_handled',
                    'severity': 'P1_high',
                    'reason': f'Error state {entity_name} modeled but not handled'
                })

    return gaps
```

**Examples**:

**Document Processing**:
- Schema: `ValidationResult` entity with `missingFields` property
- Gap: Entity generated in models.py, but no validation function uses it
- Reason: Validation logic deferred to manual implementation

**Data Pipeline**:
- Schema: `DataQualityScore` entity with `anomalies` array
- Gap: Entity exists, but no `detect_anomalies()` function generated
- Reason: Anomaly detection requires training data (post-MVP)

**Web Application**:
- Schema: `SessionExpiredError` exception entity
- Gap: Error modeled, but no function raises it in error signatures
- Reason: Session expiration logic not implemented

### 3. Test Coverage Gaps

**Definition**: Function stubs without corresponding test cases, or acceptance criteria without validation tests.

**Detection Algorithm**:
```python
def detect_test_gaps(functions, tests, requirements):
    gaps = []

    # Functions without tests
    for func in functions:
        has_test = any(t.function_name == func.name for t in tests)
        if not has_test:
            gaps.append({
                'function': func.name,
                'status': 'no_test_coverage',
                'severity': 'P1_high',
                'reason': f'Function {func.name} has no test case'
            })

    # Requirements without validation tests
    for req in requirements:
        req_tests = [t for t in tests if t.requirement_id == req.id]
        acceptance_criteria_count = len(req.acceptance_criteria)
        test_count = len(req_tests)

        if test_count < acceptance_criteria_count:
            gaps.append({
                'requirement': req.id,
                'status': 'incomplete_test_coverage',
                'severity': 'P2_medium',
                'reason': f'Requirement has {acceptance_criteria_count} acceptance criteria but only {test_count} tests'
            })

    return gaps
```

**Examples**:

**Document Processing**:
- Function: `parse_hierarchical_positions()`
- Gap: Function stub exists, but no test for hierarchical numbering edge cases
- Reason: Test spec didn't include edge case scenarios

**Data Pipeline**:
- Requirement: "Transform data with complex joins"
- Gap: Acceptance criterion "Handle missing foreign keys" not tested
- Reason: Test spec focused on happy path only

**Web Application**:
- Function: `validate_session_token()`
- Gap: No test for expired token edge case
- Reason: Test spec didn't cover expiration scenario

---

## Gap Categorization

### Priority Levels

**P0 (Critical)** - Blocks core functionality:
- Requirements with no stub or test generated
- Core functionality completely missing
- Acceptance criteria for critical paths not met

**P1 (High)** - Important for production:
- Function stub exists but no test case
- Schema entities modeled but never used
- Error states not handled
- Security-critical validation missing

**P2 (Medium)** - Nice to have:
- Function stub and test exist (TDD RED phase - expected)
- Edge cases not tested
- Performance optimization opportunities
- Non-critical features incomplete

**Deferred** - Explicitly postponed:
- Features marked as deferred in schema/spec phases
- Post-MVP features with documented rationale
- Application-specific logic requiring manual implementation

### Status Labels

- `completely_missing`: No code or stub generated
- `stub_present_no_test`: Function stub exists, no test
- `test_present_no_stub`: Test exists, no function stub
- `stub_present`: Stub and test exist (TDD RED phase)
- `entity_not_modeled`: Schema entity not in generated models
- `entity_unused`: Model exists but never referenced
- `error_not_handled`: Error state modeled but not handled
- `no_test_coverage`: Function without test
- `incomplete_test_coverage`: Fewer tests than acceptance criteria

---

## Production Readiness Calculation

### Formula

```
Production Readiness = (implemented_requirements / total_requirements) × 100

By category:
- Core functionality: (core_implemented / core_total) × core_weight
- Validation/Quality: (validation_implemented / validation_total) × validation_weight
- Error handling: (error_implemented / error_total) × error_weight

Weighted average:
  readiness = (core_weight × core_%) + (validation_weight × validation_%) + (error_weight × error_%)
```

### Category Weights (Domain-Specific)

**Document Processing**:
- Core extraction: 50%
- Validation: 30%
- Error handling: 20%

**Data Pipeline**:
- Core ETL: 60%
- Data quality: 25%
- Error handling: 15%

**Web Application**:
- Request routing: 40%
- Auth/authz: 40%
- Rate limiting: 20%

**Automation Workflow**:
- Task execution: 50%
- Workflow orchestration: 30%
- Monitoring/alerts: 20%

### Implementation Status

Requirements are categorized as:

**Implemented (100%)**:
- Function stub generated
- Test case generated
- Algorithm strategy documented
- NotImplementedError present (TDD RED phase acceptable)

**Partially Implemented (50%)**:
- Function stub generated, no test
- OR test generated, no function stub
- OR function/test exist but algorithm undefined

**Not Implemented (0%)**:
- No stub, no test
- Requirement not translated to spec
- Completely missing from code

### Example Calculations

**Document Processing (65% readiness)**:
```
Core extraction: 8/10 stubs = 80%
  - Position parsing: implemented
  - Metadata extraction: implemented
  - Gap detection: missing
  - Inheritance resolution: missing
Validation: 3/6 implementations = 50%
  - Field completeness: implemented
  - Confidence scoring: implemented
  - Format validation: missing
Error handling: 4/8 implementations = 50%
  - Basic errors: implemented
  - Edge cases: missing

Weighted: 0.5×80% + 0.3×50% + 0.2×50% = 65%
```

**Data Pipeline (70% readiness)**:
```
Core ETL: 12/15 implementations = 80%
  - Extract: implemented
  - Transform: implemented
  - Complex joins: missing
Data quality: 6/10 implementations = 60%
  - Basic validation: implemented
  - Anomaly detection: missing
Error handling: 7/10 implementations = 70%
  - Retry logic: implemented
  - Dead letter queue: missing

Weighted: 0.6×80% + 0.25×60% + 0.15×70% = 70.5%
```

---

## Domain-Agnostic Gap Patterns

### Pattern 1: Validation Logic Gap

**Characteristics**:
- Requirement mentions validation, completeness check, or quality scoring
- Schema has ValidationResult or similar entity
- Spec has validation interface with algorithm placeholder
- Generated code has stub but no validation implementation

**Examples**:
- Document: Check all required fields present
- Data Pipeline: Validate data quality before processing
- Web App: Validate user input against business rules
- Workflow: Validate task prerequisites before execution

**Typical Status**: P1 (High) - validation critical for production

### Pattern 2: Error Handling Gap

**Characteristics**:
- Schema models error states (exceptions, failure reasons)
- Spec mentions error handling in interface descriptions
- Generated code doesn't raise modeled exceptions
- Tests don't cover error scenarios

**Examples**:
- Document: Handle malformed PDF errors
- Data Pipeline: Handle missing foreign key errors
- Web App: Handle session expiration errors
- Workflow: Handle task timeout errors

**Typical Status**: P1 (High) - error handling critical for production

### Pattern 3: Feature Deferral Gap

**Characteristics**:
- Feature mentioned in discovery requirements
- Schema models data structures for feature
- Spec includes interface but marks as "deferred" or "post-MVP"
- Generated code has data models but no logic

**Examples**:
- Document: OCR quality scoring (requires training data)
- Data Pipeline: Anomaly detection (requires baseline)
- Web App: Advanced permissions (requires policy engine)
- Workflow: Smart prioritization (requires historical data)

**Typical Status**: Deferred - explicitly postponed with rationale

### Pattern 4: Edge Case Gap

**Characteristics**:
- Happy path tested
- Edge cases mentioned in acceptance criteria
- No tests for edge cases generated
- Stub implementation doesn't handle edge cases

**Examples**:
- Document: Handle positions with gaps (2, 2.1, 2.3 - missing 2.2)
- Data Pipeline: Handle null foreign keys in joins
- Web App: Handle concurrent session updates
- Workflow: Handle circular task dependencies

**Typical Status**: P2 (Medium) - edge cases nice to have

### Pattern 5: Orchestration Gap

**Characteristics**:
- Schema models workflow or state machine entities
- Individual functions generated for state transitions
- No orchestration logic to coordinate transitions
- State machine not implemented

**Examples**:
- Document: Processing workflow (upload → extract → validate → store)
- Data Pipeline: ETL orchestration (extract → transform → load stages)
- Web App: Request lifecycle (auth → route → execute → respond)
- Workflow: Task dependency graph execution

**Typical Status**: P1 (High) - orchestration needed for production

---

## Gap Analysis Checklist

Use this checklist during Phase 7:

**Requirements Review**:
- [ ] All discovery requirements have corresponding function stubs
- [ ] All acceptance criteria have corresponding tests
- [ ] Critical path requirements (P0) fully represented

**Schema Review**:
- [ ] All schema entities generated in models.py
- [ ] All entities used in at least one function signature
- [ ] Error states handled in function error signatures

**Code Review**:
- [ ] All spec interfaces have generated stubs
- [ ] All stubs have NotImplementedError bodies (TDD RED phase)
- [ ] All functions have Google-style docstrings with algorithm strategies

**Test Review**:
- [ ] All functions have at least one test case
- [ ] All acceptance criteria tested
- [ ] Edge cases from acceptance criteria tested

**Cross-Layer Traceability**:
- [ ] Requirements → Modules mapping complete
- [ ] Modules → Functions mapping complete
- [ ] Functions → Tests mapping complete
- [ ] Schema → Models mapping complete
- [ ] Models → Function signatures mapping complete

---

## Troubleshooting Common Issues

### Issue: Too Many P0 Gaps

**Symptom**: >50% of requirements have no code representation

**Possible Causes**:
- Schema phase didn't cover all requirements
- Implementation spec phase didn't create interfaces for all modules
- Code generation scripts failed to process some modules

**Resolution**:
- Review discovery → schema traceability
- Review schema → spec traceability
- Check code generation logs for errors
- Consider re-running earlier phases

### Issue: No Gaps Detected (Suspicious)

**Symptom**: Gap analysis reports 0 gaps, but intuitively code seems incomplete

**Possible Causes**:
- Gap detection algorithm too lenient
- Requirements not loaded correctly
- Schema entities not parsed correctly

**Resolution**:
- Verify requirements loaded (log count)
- Verify schema entities parsed (log count)
- Manually review a sample requirement for gap
- Check gap detection thresholds

### Issue: All Gaps Marked P2 (False Security)

**Symptom**: Everything categorized as P2 (medium priority), feels incomplete

**Possible Causes**:
- Stub generation covered all requirements
- Tests generated for all functions
- TDD RED phase mistaken for "complete"

**Resolution**:
- This is actually EXPECTED for TDD RED phase
- P2 gaps are normal - stubs exist but need implementation
- Focus on P0/P1 gaps (completely missing features)
- Update production readiness calculation to reflect implementation status

### Issue: Production Readiness Overestimated

**Symptom**: Readiness shows 90% but feels incomplete

**Possible Causes**:
- Stub presence counted as "implemented"
- NotImplementedError not detected
- Test presence (even failing) counted as coverage

**Resolution**:
- Clarify readiness definition: stubs = 50%, GREEN tests = 100%
- Adjust calculation to penalize NotImplementedError presence
- Add implementation completeness check (not just stub presence)

---

## References

- **Phase 7 (Gap Analysis)**: SKILL.md lines 300-406
- **Phase 8 (Completeness Documentation)**: SKILL.md lines 408-768
- **TODO.md template**: assets/templates/TODO.md.template
- **ADR.md template**: assets/templates/ADR.md.template
- **README Known Limitations template**: assets/templates/README_known_limitations.md.template

---

**Document Version**: 1.0 (Round 2 - Fix #4)
**Last Updated**: 2025-01-07

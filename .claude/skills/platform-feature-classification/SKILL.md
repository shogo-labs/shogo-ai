---
name: platform-feature-classification
description: >
  Evidence-based archetype validation for platform features. Use after
  platform-feature-analysis to validate or correct the initial archetype
  assessment with codebase evidence. Takes FeatureSession with classification
  evidence findings and applies explicit criteria to determine final archetype
  and applicable patterns. Invoke when session status=classification, or when
  ready to "validate archetype", "confirm classification", "finalize patterns",
  or "check feature type".
---

# Platform Feature Classification

Validate and finalize feature archetype using evidence-based decision framework.

## Input

- `FeatureSession` with status=`classification`
- `Requirement` entities from discovery
- `AnalysisFinding` entities from analysis (especially `classification_evidence` type)
- Initial assessment from discovery

## Output

- Validated `featureArchetype` on FeatureSession
- `applicablePatterns` array populated based on archetype
- `ClassificationDecision` entity recording rationale
- Session status → `design`

---

## Workflow

### Phase 1: Load Context

```javascript
schema.load("platform-features")

// Query session by name
session = store.query({
  model: "FeatureSession",
  schema: "platform-features",
  filter: { name: "..." },
  terminal: "first"
})

// Query related entities
requirements = store.query({
  model: "Requirement",
  schema: "platform-features",
  filter: { session: session.id }
})

findings = store.query({
  model: "AnalysisFinding",
  schema: "platform-features",
  filter: { session: session.id }
})

classificationEvidence = store.query({
  model: "AnalysisFinding",
  schema: "platform-features",
  filter: { session: session.id, type: "classification_evidence" }
})
```

Present summary:
```
Session: {name}
Status: classification

Initial Assessment: {session.initialAssessment.likelyArchetype}
Evidence from discovery: {session.initialAssessment.indicators}
Uncertainties: {session.initialAssessment.uncertainties}

Classification Evidence from Analysis: {classificationEvidence.length}
- {evidence 1}
- {evidence 2}

Ready to validate archetype?
```

### Phase 2: Apply Decision Framework

Use the decision framework to validate the archetype. See [decision-framework.md](references/decision-framework.md).

**Core Question**: Does this feature CALL an external API?

| Answer | Classification | Required Evidence |
|--------|---------------|-------------------|
| YES, and only external data | **Service** | External API endpoint, provider, credentials |
| YES, plus local domain entities | **Hybrid** | External API + local MST entities + sync pattern |
| NO, all data is local | **Domain** | Local MST operations, SQL backend persistence |
| NO, cross-cutting concern | **Infrastructure** | Used by multiple features, no domain entities |

**Check evidence against criteria:**

For each archetype, specific evidence is REQUIRED. If evidence is missing, the archetype does NOT apply.

```
Evidence Check for: {initial archetype}

Service criteria:
- [ ] External API endpoint identified? {yes/no}
- [ ] Provider mentioned? {yes/no}
- [ ] Credential requirement? {yes/no}
- [ ] Provider swapping need? {yes/no}

Domain criteria:
- [ ] All data operations local? {yes/no}
- [ ] No external API calls? {yes/no}
- [ ] Local persistence via SQL backend? {yes/no}

Based on evidence: {archetype} is {confirmed/not supported}
```

**Common Correction Scenarios:**

1. **Reference Confusion**: Initial "Hybrid" because feature "references users from auth"
   - Check: Does it CALL auth API, or just store user IDs?
   - If storing IDs only → Correct to **Domain**

2. **Future-proofing**: Initial "Service" because "might need external provider later"
   - Check: Does current requirement specify external API?
   - If no external API now → Correct to **Domain**

3. **Over-abstraction**: Initial "Service" for purely local feature
   - Check: Would removing IService break anything external?
   - If nothing external breaks → Correct to **Domain**

### Phase 3: Record Decision

```javascript
const validatedArchetype = "domain" // or service/hybrid/infrastructure

store.create("ClassificationDecision", "platform-features", {
  id: crypto.randomUUID(),
  session: session.id,
  initialAssessment: session.initialAssessment?.likelyArchetype,
  validatedArchetype: validatedArchetype,
  evidenceChecklist: {
    externalApiIdentified: false,
    providerMentioned: false,
    credentialRequired: false,
    localDataOperations: true,
    localPersistence: true
  },
  rationale: "Feature manages local entities. References to external IDs are " +
             "foreign keys, not API calls. No external service integration required.",
  correction: initialAssessment !== validatedArchetype
              ? `Corrected from ${initialAssessment} to ${validatedArchetype}: [reason]`
              : null,
  createdAt: Date.now()
})
```

### Phase 4: Update Session with Validated Archetype

```javascript
// Pattern assignment by archetype
const patternMap = {
  service: ["service-interface", "environment-extension", "mock-testing", "enhancement-hooks"],
  domain: ["enhancement-hooks"],  // Persistence is automatic via domain() + SQL backend
  hybrid: ["service-interface", "environment-extension", "mock-testing", "enhancement-hooks", "provider-sync"],
  infrastructure: ["service-interface", "environment-extension", "mixin-composition"]
}

store.update(session.id, "FeatureSession", "platform-features", {
  featureArchetype: validatedArchetype,
  applicablePatterns: patternMap[validatedArchetype],
  status: "design",
  updatedAt: Date.now()
})
```

**Critical Pattern Assignment:**

| Archetype | Patterns | Task Count |
|-----------|----------|------------|
| Domain | enhancement-hooks | ~3 |
| Service | service-interface, environment-extension, mock-testing, enhancement-hooks | ~7 |
| Hybrid | All service + domain + provider-sync | ~7+ |
| Infrastructure | service-interface, environment-extension, mixin-composition | ~5-6 |

**Domain archetype gets NO service-interface pattern.** This is the key distinction.

### Phase 5: Handoff to Design

Present classification result:
```
Classification Complete

Initial Assessment: {initial}
Validated Archetype: {validated}
{If corrected: "Correction: {reason}"}

Evidence Summary:
- {key evidence 1}
- {key evidence 2}

Applicable Patterns:
- {pattern 1}
- {pattern 2}

Session status: classification → design
Ready for platform-feature-design to create schema.
```

---

## Anti-Pattern Detection

### Reference Confusion (Most Common)

**Symptom**: Feature classified as Hybrid/Service because it "references users from auth"

**Reality**: Referencing user IDs is just storing a foreign key. It's not calling an API.

**Detection**: Ask "Does THIS feature make HTTP calls to an external service?"
- Storing `userId: string` in local entity → NOT an API call
- Fetching user data from auth service → IS an API call

**Fix**: If no external API calls, classify as **Domain**

### Future-Proofing Trap

**Symptom**: Feature classified as Service because "we might need to swap providers later"

**Reality**: If there's no external provider now, there's nothing to swap.

**Detection**: Check if requirements mention specific external service
- "Will eventually sync to cloud" → No external API now → **Domain**
- "Integrates with Stripe for payments" → External API → **Service**

**Fix**: Design for current requirements. Domain can evolve to Hybrid later.

### Over-Abstraction

**Symptom**: Service interface created for purely local feature

**Test**: "If I remove IService, what external system breaks?"
- If answer is "nothing" → Feature is **Domain**, not Service

**Fix**: Reclassify as Domain, remove service-interface from patterns

---

## Wavesmith Operations

```javascript
// Phase 1: Load context
schema.load("platform-features")

session = store.query({
  model: "FeatureSession",
  schema: "platform-features",
  filter: { name: "..." },
  terminal: "first"
})

requirements = store.query({
  model: "Requirement",
  schema: "platform-features",
  filter: { session: session.id }
})

findings = store.query({
  model: "AnalysisFinding",
  schema: "platform-features",
  filter: { session: session.id }
})

// Phase 3: Record decision
store.create("ClassificationDecision", "platform-features", {...})

// Phase 4: Update session
store.update(session.id, "FeatureSession", "platform-features", {
  featureArchetype: "domain",
  applicablePatterns: ["enhancement-hooks"],
  status: "design",
  updatedAt: Date.now()
})
```

---

## References

- [decision-framework.md](references/decision-framework.md) - Classification criteria and evidence requirements
- [worked-examples.md](references/worked-examples.md) - Generic worked examples for each archetype

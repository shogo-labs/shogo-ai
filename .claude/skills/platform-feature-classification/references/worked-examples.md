# Worked Classification Examples

Generic examples demonstrating the classification process for each archetype.

---

## Example 1: Domain Archetype

### Feature: Inventory Management

**Initial Assessment from Discovery:**
```
likelyArchetype: "hybrid"
indicators: ["manages stock levels", "references warehouse IDs", "will sync to backend"]
uncertainties: ["does it call external API or just store data locally?"]
```

**Classification Evidence from Analysis:**
- `classification_evidence`: "No external API calls found in requirements"
- `classification_evidence`: "Stock levels stored via CollectionPersistable"
- `classification_evidence`: "Warehouse IDs are foreign keys, not fetched from API"
- `pattern`: "Similar local-only features use enhancement-hooks pattern"

**Decision Framework Application:**

```
Q1: Does feature CALL external API?
→ NO - all data operations are local MST mutations

Q2: Is this cross-cutting?
→ NO - specific to inventory domain

Result: DOMAIN
```

**Evidence Checklist:**
- [x] All data operations local
- [x] No external API calls
- [x] Persistence via CollectionPersistable
- [x] References are just stored IDs

**Correction**: Hybrid → Domain
**Rationale**: "Will sync to backend later" is future requirement, not current. Referencing warehouse IDs is storing foreign keys, not calling an API.

**Pattern Assignment:**
- enhancement-hooks
- collection-persistable

**Task Count**: 4 (domain store, exports, context, demo)

---

## Example 2: Service Archetype

### Feature: Payment Processing

**Initial Assessment from Discovery:**
```
likelyArchetype: "service"
indicators: ["process payments via Stripe", "needs API credentials", "multiple payment providers"]
uncertainties: []
```

**Classification Evidence from Analysis:**
- `classification_evidence`: "Stripe API integration required"
- `classification_evidence`: "Payment credentials managed via environment"
- `classification_evidence`: "Mock service needed for testing"
- `pattern`: "Auth feature uses IService pattern for similar external integration"

**Decision Framework Application:**

```
Q1: Does feature CALL external API?
→ YES - Stripe API for payment processing

Q2: Does it need local domain entities?
→ NO - just wraps Stripe, no local payment data

Result: SERVICE
```

**Evidence Checklist:**
- [x] External API endpoint (Stripe)
- [x] Provider mentioned (Stripe)
- [x] Credentials required (API key)
- [x] Swappability needed (mock for testing)

**Confirmation**: Service (no correction needed)

**Pattern Assignment:**
- service-interface
- environment-extension
- mock-testing
- enhancement-hooks

**Task Count**: 7 (types, mock, env, domain, exports, context, demo)

---

## Example 3: Hybrid Archetype

### Feature: CRM Integration

**Initial Assessment from Discovery:**
```
likelyArchetype: "hybrid"
indicators: ["sync contacts from Salesforce", "add local notes and tags", "offline support"]
uncertainties: ["how much local vs external?"]
```

**Classification Evidence from Analysis:**
- `classification_evidence`: "Salesforce API for contact source of truth"
- `classification_evidence`: "Local Contact entity extends with notes, tags"
- `classification_evidence`: "Sync pattern needed: fetch → local → subscribe"
- `pattern`: "Provider sync pattern in codebase handles similar cases"

**Decision Framework Application:**

```
Q1: Does feature CALL external API?
→ YES - Salesforce API for contacts

Q2: Does it need local domain entities?
→ YES - Contact entity with local-only fields (notes, tags)

Result: HYBRID
```

**Evidence Checklist:**
- [x] External API (Salesforce)
- [x] Local entities (Contact with local extensions)
- [x] Sync pattern (fetch external, extend locally)
- [x] Both layers needed (can't do either alone)

**Confirmation**: Hybrid (no correction needed)

**Pattern Assignment:**
- service-interface
- environment-extension
- mock-testing
- enhancement-hooks
- provider-sync

**Task Count**: 7+ (full service layer + domain + sync)

---

## Example 4: Infrastructure Archetype

### Feature: Request Logging

**Initial Assessment from Discovery:**
```
likelyArchetype: "infrastructure"
indicators: ["logs all API requests", "configurable log levels", "used across features"]
uncertainties: []
```

**Classification Evidence from Analysis:**
- `classification_evidence`: "Cross-cutting concern, not domain-specific"
- `classification_evidence`: "No domain entities, just logging utility"
- `classification_evidence`: "Mixin pattern for adding to services"

**Decision Framework Application:**

```
Q1: Does feature CALL external API?
→ NO - logs locally or to log service

Q2: Is this cross-cutting?
→ YES - affects all features transparently

Result: INFRASTRUCTURE
```

**Evidence Checklist:**
- [x] Cross-cutting concern
- [x] No domain entities
- [x] Reusable across features

**Confirmation**: Infrastructure (no correction needed)

**Pattern Assignment:**
- service-interface (for swappable log destinations)
- environment-extension
- mixin-composition

**Task Count**: 5-6

---

## Example 5: Correction Scenario

### Feature: Project Workspace

**Initial Assessment from Discovery:**
```
likelyArchetype: "hybrid"
indicators: ["manages projects and tasks", "references user IDs from auth", "will need cloud sync"]
uncertainties: ["is user reference an API call?"]
```

**Classification Evidence from Analysis:**
- `classification_evidence`: "No external API calls in implementation"
- `classification_evidence`: "User IDs stored as strings, not fetched from auth"
- `classification_evidence`: "All CRUD via local MST mutations"
- `classification_evidence`: "Cloud sync is future requirement, not current"

**Decision Framework Application:**

```
Q1: Does feature CALL external API?
→ NO - all operations are local

Analysis of uncertainties:
- "References user IDs from auth" → Storing userId as foreign key, NOT calling auth API
- "Will need cloud sync" → Future requirement, not current scope

Result: DOMAIN (corrected from Hybrid)
```

**Evidence Checklist:**
- [x] All data operations local
- [x] No external API calls
- [x] User IDs are foreign keys, not API calls
- [x] "Future sync" is not current requirement

**Correction**: Hybrid → Domain
**Rationale**:
1. Storing user IDs is foreign key storage, not API integration
2. "Will need sync" describes future state, not current
3. No evidence of external API in current requirements

**Pattern Assignment:**
- enhancement-hooks
- collection-persistable
- (NO service-interface)

**Task Count**: 4 (not 7)

---

## Summary Table

| Feature | Initial | Evidence | Final | Correction |
|---------|---------|----------|-------|------------|
| Inventory | Hybrid | Local data, no API | Domain | Yes |
| Payments | Service | Stripe API | Service | No |
| CRM | Hybrid | External + local entities | Hybrid | No |
| Logging | Infrastructure | Cross-cutting | Infrastructure | No |
| Workspace | Hybrid | Foreign keys, not API | Domain | Yes |

**Key insight**: The most common correction is Hybrid/Service → Domain when "external reference" is actually just storing foreign keys, not calling APIs.

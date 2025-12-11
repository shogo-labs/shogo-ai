# Classification Decision Framework

Evidence-based criteria for validating feature archetypes.

## Core Decision Tree

```
START: Does this feature CALL an external API?

Q1: Does this feature make HTTP calls to an external service?
    |
    +-- YES → Q2: Does it also need local domain entities?
    |          |
    |          +-- YES, extends external data → HYBRID
    |          +-- NO, just proxies/wraps external → SERVICE
    |
    +-- NO  → Q3: Is this a cross-cutting concern?
               |
               +-- YES (logging, caching, auth middleware) → INFRASTRUCTURE
               +-- NO, manages local business entities → DOMAIN
```

## Evidence Requirements by Archetype

### Service Archetype

**All of these MUST be true:**

| Criterion | Evidence Required |
|-----------|------------------|
| External API | Specific endpoint mentioned (e.g., "Supabase auth", "Stripe API") |
| Provider | Named provider in requirements (not just "might use X later") |
| Credentials | API key, secret, or auth token requirement |
| Swappability | Need to swap implementations (mock for testing at minimum) |

**If ANY criterion lacks evidence → NOT Service**

Example valid evidence:
- "Authenticate via Supabase Auth API"
- "Process payments through Stripe"
- "Fetch weather data from OpenWeather API"

Example INVALID evidence:
- "References user IDs" (just foreign keys, not API calls)
- "Might sync to cloud later" (no current external dependency)
- "Could use different databases" (infrastructure, not service)

### Domain Archetype

**All of these MUST be true:**

| Criterion | Evidence Required |
|-----------|------------------|
| Local data operations | All CRUD happens via MST mutations |
| No external API | Requirements don't mention external service calls |
| MST persistence | CollectionPersistable or equivalent for storage |
| Foreign keys acceptable | References to external IDs (user IDs) are stored, not fetched |

**Key distinction**: Storing `userId: string` is NOT calling an external API.

Example valid evidence:
- "Store organization hierarchy locally"
- "Manage project data with relationships"
- "Track user preferences in app state"

### Hybrid Archetype

**All of these MUST be true:**

| Criterion | Evidence Required |
|-----------|------------------|
| External API | Source of truth lives externally |
| Local entities | MST models that mirror or extend external data |
| Sync pattern | initialize() fetches, subscribe() updates |
| Both layers needed | Can't just use service OR domain alone |

Example valid evidence:
- "Sync customer data from CRM, add local notes"
- "Mirror inventory from warehouse API, track local adjustments"
- "Fetch external catalog, extend with local pricing"

### Infrastructure Archetype

**All of these MUST be true:**

| Criterion | Evidence Required |
|-----------|------------------|
| Cross-cutting | Affects multiple features transparently |
| No domain entities | Provides utility, not business objects |
| Reusable | Same implementation serves all consumers |

Example valid evidence:
- "Add request logging to all API calls"
- "Implement caching layer for performance"
- "Add rate limiting middleware"

---

## Common Misclassification Scenarios

### Scenario 1: Foreign Key Confusion

**Initial**: "Hybrid" because "stores references to auth users"

**Analysis**:
- Q: Does feature CALL auth API? → No
- Q: Does feature FETCH user data? → No
- Q: Does feature just STORE user IDs? → Yes

**Correction**: Domain (storing foreign keys ≠ API integration)

### Scenario 2: Future-Proofing Trap

**Initial**: "Service" because "will eventually integrate with cloud"

**Analysis**:
- Q: Current requirements specify external API? → No
- Q: Any provider mentioned? → No
- Q: Credentials needed? → No

**Correction**: Domain (design for now, can evolve)

### Scenario 3: Complexity Confusion

**Initial**: "Service" because "has complex permission logic"

**Analysis**:
- Q: Where does permission data live? → Local MST
- Q: External authorization service? → No
- Q: All logic runs locally? → Yes

**Correction**: Domain (complexity doesn't require service abstraction)

### Scenario 4: Reference Implementation Confusion

**Initial**: "Service" because "similar to auth which uses IService"

**Analysis**:
- Q: Does THIS feature call external API? → No
- Q: Auth calls Supabase; does this? → No
- Q: Same pattern required? → No, different need

**Correction**: Domain (pattern depends on THIS feature's needs)

---

## Validation Questions

Before finalizing classification, answer these:

1. **"If I remove IService, what external system breaks?"**
   - Nothing → Domain
   - External API fails → Service/Hybrid

2. **"Can this feature work without network access?"**
   - Yes → Domain
   - No → Service/Hybrid

3. **"Where is the source of truth for this data?"**
   - Local MST store → Domain
   - External system → Service
   - Both (sync) → Hybrid

4. **"Is the external reference an API call or a stored ID?"**
   - Stored ID → Domain
   - API call → Service/Hybrid

---

## Pattern Assignment Rules

Once archetype is validated, assign patterns:

```javascript
const patternMap = {
  service: [
    "service-interface",     // IService + implementations
    "environment-extension", // Extend IEnvironment
    "mock-testing",          // MockService for tests
    "enhancement-hooks"      // Domain logic in store
  ],
  domain: [
    "enhancement-hooks",     // Domain logic in store
    "collection-persistable" // Direct MST persistence
    // NO service-interface - this is key!
  ],
  hybrid: [
    "service-interface",
    "environment-extension",
    "mock-testing",
    "enhancement-hooks",
    "provider-sync"          // Sync external → local
  ],
  infrastructure: [
    "service-interface",
    "environment-extension",
    "mixin-composition"      // Cross-cutting behaviors
  ]
}
```

**The critical distinction**: Domain archetype NEVER gets `service-interface` pattern. This prevents unnecessary abstraction layers.

# Web Application Example

This is a **contrived, simplified example** demonstrating the transformation from discovery outputs to Enhanced JSON Schema for a web application domain.

**Domain**: Recipe collection and sharing web app

**Problem**: Users need to save recipes, organize them into collections, and share with others.

---

## Discovery Outputs (Layer 1)

### ProblemStatement

```
Description: "Need a web app where users can save recipes, organize them into collections (e.g., 'Dinner Ideas', 'Desserts'), and share collections with friends."

Pain Points:
- Currently saving recipes in notes app with no organization
- Can't easily share multiple recipes at once
- No way to see what friends are cooking
- Hard to find recipes again after saving

Desired Outcome: "Web app where I can quickly save recipes, organize them into themed collections, and share entire collections with friends via link."
```

### Analysis

```
Findings:
{
  "coreFeatures": ["recipe_saving", "collection_management", "sharing"],
  "userActions": ["create_recipe", "add_to_collection", "share_collection", "view_shared"],
  "dataStructures": {
    "recipe": {
      "fields": ["title", "ingredients", "instructions", "prepTime"],
      "source": "user_input or url"
    },
    "collection": {
      "fields": ["name", "description", "recipes"],
      "visibility": ["private", "shared"]
    }
  }
}

Complexity: low

Complexity Rationale: "Low complexity - straightforward CRUD operations with recipes and collections. No complex business logic, algorithms, or integrations. Simple many-to-many relationship (recipes can be in multiple collections)."
```

### Requirements (simplified)

**req-001**: Create and store recipes
- Description: "Users can create recipes with title, ingredients, instructions, and prep time"
- Category: data-management
- Acceptance Criteria:
  - "Recipe has required fields: title, ingredients, instructions"
  - "Prep time is optional"
  - "Tracks when recipe was created"

**req-002**: Organize recipes into collections
- Description: "Users can create named collections and add multiple recipes to each"
- Category: organization
- Acceptance Criteria:
  - "Collection has name and optional description"
  - "One recipe can be in multiple collections"
  - "Collection shows recipe count"

**req-003**: Share collections
- Description: "Users can generate shareable links for collections"
- Category: sharing
- Acceptance Criteria:
  - "Collection has visibility status (private or shared)"
  - "Shared collections get a unique link"
  - "Tracks when collection was shared"

### SolutionProposal

```
Phases:
1. Recipe Management
   - Goal: CRUD operations for recipes
   - Deliverables: Recipe entity, storage, user interface

2. Collection System
   - Goal: Group recipes into collections
   - Deliverables: Collection entity, many-to-many relationships

3. Sharing Feature
   - Goal: Generate shareable links
   - Deliverables: Share link generation, public view
```

---

## Transformation Process (Layer 1 → Layer 2)

### Phase 1: Context & Domain Understanding

**Nouns identified in requirements**:
- User (implied, owns recipes and collections)
- Recipe (mentioned in req-001, req-002, req-003)
- Collection (mentioned in req-002, req-003)
- Ingredient (mentioned in req-001)
- Share link (mentioned in req-003)

**Domain inference**: Web application with user-generated content, collections, and sharing.

---

### Phase 2: Domain Model Design

#### Concept Categorization

**Entities** (independent lifecycle, have ID):

1. **User**
   - Why entity: Central to ownership, has independent existence
   - Mentioned in: Implied by all requirements (ownership)
   - Lifecycle: Created on signup, exists until account deleted

2. **Recipe**
   - Why entity: Core content, can exist independently, queryable
   - Mentioned in: req-001, req-002
   - Lifecycle: Created by user, exists until deleted

3. **Collection**
   - Why entity: Organizational structure with lifecycle
   - Mentioned in: req-002, req-003
   - Lifecycle: Created by user, modified, shared, exists until deleted

**Value Objects** (embedded, no ID):

1. **Ingredient** (part of Recipe)
   - Why value object: Only exists within recipe context
   - No independent queries needed
   - Simple structure: name and amount

**Enums** (from findings and requirements):

1. **Visibility**: ["private", "shared"]
   - Source: analysis.findings.dataStructures.collection.visibility
   - Source: req-003 acceptance criteria

#### Relationship Modeling

**User → Recipe** (1:N reference)
- Pattern: User creates many recipes
- Cardinality: 1:N
- Schema: Recipe references User (Recipe.owner → User)

**User → Collection** (1:N reference)
- Pattern: User creates many collections
- Cardinality: 1:N
- Schema: Collection references User (Collection.owner → User)

**Collection ↔ Recipe** (N:M reference)
- Pattern: "One recipe can be in multiple collections"
- Cardinality: N:M
- Schema: Collection.recipes → Recipe[] (array reference)

**Recipe → Ingredients** (1:N composition)
- Pattern: Recipe contains ingredients list
- Cardinality: 1:N embedded
- Schema: Nested array within Recipe

#### Constraint Extraction

From **req-001** acceptance criteria:
- Recipe.title: required (string)
- Recipe.ingredients: required (array, at least 1)
- Recipe.instructions: required (string)
- Recipe.prepTime: optional (number, minutes)

From **req-002** acceptance criteria:
- Collection.name: required (string)
- Collection.description: optional (string)
- Collection.recipes: array reference (can be empty)

From **req-003** acceptance criteria:
- Collection.visibility: required (enum: private/shared)
- Collection.shareLink: optional (only when visibility = shared)
- Collection.sharedAt: optional (timestamp when shared)

#### Illustrative Model

```
User
├─ id: string (required)
├─ username: string (required)
├─ email: string (required)
└─ createdAt: number (required)

Recipe
├─ id: string (required)
├─ owner: → User (reference, required)
├─ title: string (required)
├─ instructions: string (required)
├─ prepTime: number (optional, minutes)
├─ createdAt: number (required)
└─ ingredients: Ingredient[] (embedded array, required)
   ├─ name: string (required)
   └─ amount: string (required)

Collection
├─ id: string (required)
├─ owner: → User (reference, required)
├─ name: string (required)
├─ description: string (optional)
├─ recipes: → Recipe[] (array reference)
├─ visibility: enum ["private", "shared"] (required)
├─ shareLink: string (optional, only if shared)
├─ sharedAt: number (optional, only if shared)
└─ createdAt: number (required)
```

---

### Phase 3: Schema Generation

```json
{
  "id": "qwe-789-rty",
  "name": "recipe-collection-app",
  "format": "enhanced-json-schema",
  "createdAt": 1735530000000,
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "User": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "username": {
          "type": "string"
        },
        "email": {
          "type": "string",
          "format": "email"
        },
        "createdAt": {
          "type": "number"
        }
      },
      "required": ["id", "username", "email", "createdAt"],
      "x-original-name": "User"
    },
    "Recipe": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "owner": {
          "type": "string",
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "User"
        },
        "title": {
          "type": "string"
        },
        "instructions": {
          "type": "string"
        },
        "prepTime": {
          "type": "number"
        },
        "createdAt": {
          "type": "number"
        },
        "ingredients": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "amount": {
                "type": "string"
              }
            },
            "required": ["name", "amount"]
          },
          "minItems": 1
        }
      },
      "required": ["id", "owner", "title", "instructions", "createdAt", "ingredients"],
      "x-original-name": "Recipe"
    },
    "Collection": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "owner": {
          "type": "string",
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "User"
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "recipes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "x-mst-type": "reference",
          "x-reference-type": "array",
          "x-arktype": "Recipe[]"
        },
        "visibility": {
          "type": "string",
          "enum": ["private", "shared"]
        },
        "shareLink": {
          "type": "string"
        },
        "sharedAt": {
          "type": "number"
        },
        "createdAt": {
          "type": "number"
        }
      },
      "required": ["id", "owner", "name", "visibility", "createdAt"],
      "x-original-name": "Collection"
    }
  }
}
```

---

## Key Patterns Demonstrated

### 1. User Ownership Pattern

Both Recipe and Collection reference User as owner:
- `Recipe.owner → User`
- `Collection.owner → User`

**Pattern**: Common in web apps - track who created content.

### 2. Many-to-Many Relationships

Collection ↔ Recipe is N:M:
- Collection has `recipes: Recipe[]` (array reference)
- Recipe can be in multiple Collections (referenced by multiple collections)

**Pattern**: Use array references (`x-reference-type: "array"`) for N:M relationships.

### 3. Conditional Fields

shareLink and sharedAt only exist when visibility = "shared":
- Both optional in schema
- Application logic enforces conditional presence

**Pattern**: Optional fields for state-dependent data.

### 4. Array Constraints

Recipe.ingredients requires `minItems: 1`:
- From req-001: "ingredients" required
- Array can't be empty

**Pattern**: Use `minItems` for non-empty array requirements.

### 5. Format Validation

User.email has `format: "email"`:
- Semantic validation hint
- Wavesmith/validation layer can enforce format

**Pattern**: Use JSON Schema `format` for common validation patterns.

---

## Validation (Phase 4)

```javascript
// Save schema
fs.writeFileSync(".schemas/recipe-collection-app/schema.json", JSON.stringify(schema, null, 2))

// Register via Wavesmith
result = wavesmith.schema_set("recipe-collection-app", schema)
// Returns: { ok: true, schemaId: "qwe-789-rty" }

// Load to test MST generation
load_result = wavesmith.schema_load("recipe-collection-app")
// Returns: {
//   ok: true,
//   schemaId: "qwe-789-rty",
//   models: [
//     { name: "User", fields: ["id", "username", "email", ...] },
//     { name: "Recipe", fields: ["id", "owner", "title", ...] },
//     { name: "Collection", fields: ["id", "owner", "name", ...] }
//   ]
// }
```

**Success**: Schema compiles, generates User, Recipe, and Collection models.

---

## Comparison Across All Three Domains

| Aspect | Document | Data Pipeline | Web App |
|--------|----------|--------------|---------|
| **Core entities** | Document, Review | SyncRun, SourceRecord | User, Recipe, Collection |
| **Parent-child** | Document ← Review | SyncRun ← SourceRecord | User ← Recipe/Collection |
| **Many-to-many** | None | None | Collection ↔ Recipe |
| **Embedded data** | Comment[] | ValidationError[] | Ingredient[] |
| **Workflow states** | Yes (status enum) | Yes (processing stages) | Limited (visibility enum) |
| **Ownership** | Implicit | None | Explicit (owner references) |

**Pattern**: Three completely different domains, same transformation logic.

---

## Summary

This example demonstrates:
- **User ownership**: Explicit creator/owner tracking
- **Many-to-many relationships**: Using array references
- **Conditional fields**: Optional fields for state-specific data
- **Array constraints**: minItems for non-empty arrays
- **Format validation**: Using JSON Schema format hints

**The key**: Recipe app, document approval system, and data pipeline all use the same transformation patterns. The skill adapts to domain by extracting concepts from requirements, not by recognizing "web app patterns" or "document patterns".

**Cross-domain learning**:
- All three domains use ownership/parent-child relationships
- All three track timestamps for lifecycle events
- All three use enums for finite option sets
- All three embed simple data structures as value objects
- None make assumptions - all derive from discovery outputs

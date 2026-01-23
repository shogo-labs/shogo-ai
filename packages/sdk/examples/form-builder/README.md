# Form Builder - Shogo SDK Example

A **form builder application** that lets users create custom forms with dynamic fields, demonstrating advanced **@shogo-ai/sdk** patterns.

> **Note**: This is a tool for BUILDING forms with dynamic fields.
> If you need a simple pre-built form, see the **feedback-form** template instead.

## What This Template Does

- Create multiple forms with custom names and descriptions
- Add dynamic fields (text, email, number, date, select, radio, checkbox, rating)
- Configure field validation (required/optional)
- Publish forms with unique shareable URLs
- View and manage submissions
- Track statistics (total responses, unread, today)

## Key Patterns Demonstrated

| Pattern | Implementation |
|---------|----------------|
| **Dynamic Schemas** | Fields defined at runtime via `Field` model |
| **Position Ordering** | `Field.position` for drag-and-drop ordering |
| **JSON Fields** | `Field.options` stores select/radio options as JSON |
| **Nested Includes** | Form → Fields → Responses in single query |
| **Slug-based URLs** | Human-readable public form URLs |
| **Aggregations** | Submission counts and statistics |

## Getting Started

1. Install dependencies:
   ```bash
   bun install
   ```

2. Set up the database:
   ```bash
   bun run db:push
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
form-builder/
├── prisma/
│   └── schema.prisma    # User, Form, Field, Submission, Response models
├── src/
│   ├── lib/
│   │   ├── db.ts        # Prisma client
│   │   └── shogo.ts     # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx   # Root layout
│   │   ├── index.tsx    # Forms list (dashboard)
│   │   ├── forms.$formId.tsx           # Form editor
│   │   ├── forms.$formId.submissions.tsx  # Submissions list
│   │   └── f.$slug.tsx  # Public form view
│   └── utils/
│       ├── user.ts      # User operations
│       ├── forms.ts     # Form CRUD
│       ├── fields.ts    # Field CRUD with position ordering
│       └── submissions.ts # Submission handling
├── package.json
└── vite.config.ts
```

## Data Model

```prisma
model Form {
  id          String   @id
  name        String
  slug        String   @unique  // For public URLs
  isPublished Boolean
  isAcceptingResponses Boolean
  fields      Field[]
  submissions Submission[]
}

model Field {
  id        String  @id
  formId    String
  type      String  // text, email, select, etc.
  label     String
  position  Int     // For ordering
  isRequired Boolean
  options   String? // JSON for select/radio options
}

model Submission {
  id        String @id
  formId    String
  responses Response[]
}

model Response {
  id           String @id
  submissionId String
  fieldId      String
  value        String
}
```

## SDK Usage Examples

### Creating a Form

```typescript
const form = await shogo.db.form.create({
  data: {
    name: 'Contact Form',
    slug: 'contact-abc123',
    userId: user.id,
  },
})
```

### Adding a Field with Position

```typescript
// Get current max position
const lastField = await shogo.db.field.findFirst({
  where: { formId },
  orderBy: { position: 'desc' },
})

const field = await shogo.db.field.create({
  data: {
    formId,
    type: 'select',
    label: 'Country',
    position: (lastField?.position ?? -1) + 1,
    isRequired: true,
    options: JSON.stringify([
      { value: 'us', label: 'United States' },
      { value: 'uk', label: 'United Kingdom' },
    ]),
  },
})
```

### Fetching Form with Nested Data

```typescript
const form = await shogo.db.form.findUnique({
  where: { slug: 'contact-abc123' },
  include: {
    fields: {
      orderBy: { position: 'asc' },
    },
    _count: {
      select: { submissions: true },
    },
  },
})
```

### Creating a Submission with Responses

```typescript
const submission = await shogo.db.submission.create({
  data: {
    formId,
    responses: {
      create: [
        { fieldId: 'field1', value: 'John Doe' },
        { fieldId: 'field2', value: 'john@example.com' },
      ],
    },
  },
  include: { responses: true },
})
```

## Field Types

| Type | Description | Options |
|------|-------------|---------|
| `text` | Single-line text input | - |
| `textarea` | Multi-line text | - |
| `email` | Email validation | - |
| `number` | Numeric input | - |
| `date` | Date picker | - |
| `select` | Dropdown | JSON array of options |
| `radio` | Single choice | JSON array of options |
| `checkbox` | Multiple choice | JSON array of options |
| `rating` | 1-5 star rating | - |

## When to Use This Template

✅ **Use this template when:**
- Users need to create their own custom forms
- Form fields should be configurable
- Multiple different forms are needed
- You need position ordering for fields

❌ **Use feedback-form template instead when:**
- You need a single, fixed form
- Form fields are known and don't change
- Simpler data model is preferred

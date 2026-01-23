# Feedback Form - Shogo SDK Example

A **pre-built feedback form** demonstrating the **@shogo-ai/sdk** with Prisma pass-through.

> **Note**: This is a ready-to-use form with fixed fields (name, email, rating, category, message).
> If you need to build custom forms with dynamic fields, see the **form-builder** template instead.

## What This Template Does

- Collect customer/user feedback via a shareable public form
- View submissions in an inbox-style dashboard
- Filter by read/unread/starred
- See aggregated statistics (average rating, category breakdown, recommendation rate)

## Key Concept: Prisma Pass-Through

The SDK's `db` property is a direct reference to your Prisma client:

```typescript
import { createClient } from '@shogo-ai/sdk'
import { prisma } from './db'

const shogo = createClient({
  apiUrl: 'http://localhost:3000',
  db: prisma,  // Your Prisma client becomes shogo.db
})

// shogo.db IS your Prisma client - same API, zero overhead
const submissions = await shogo.db.submission.findMany({
  where: { userId, isRead: false },
  orderBy: { createdAt: 'desc' }
})
```

## Features

- **Public Form**: Shareable URL for collecting feedback (no auth required)
- **Dashboard**: View all submissions with filtering
- **Statistics**: Aggregated metrics using Prisma queries
- **CRUD Operations**: Create, read, update, delete via `shogo.db.submission.*`

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

5. Create a user, then share your form link!

## Project Structure

```
feedback-form/
├── prisma/
│   └── schema.prisma    # User & Submission models
├── src/
│   ├── lib/
│   │   ├── db.ts        # Prisma client
│   │   └── shogo.ts     # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx   # Root layout
│   │   ├── index.tsx    # Dashboard & submissions list
│   │   └── form.$userId.tsx  # Public feedback form
│   └── utils/
│       ├── user.ts      # User operations via shogo.db
│       └── submissions.ts # Submission operations & aggregations
├── package.json
└── vite.config.ts
```

## Data Model

```prisma
model User {
  id          String       @id @default(cuid())
  email       String       @unique
  name        String?
  submissions Submission[]
}

model Submission {
  id             String   @id @default(cuid())
  name           String   // Respondent name
  email          String   // Respondent email  
  rating         Int      // 1-5 star rating
  category       String   // feedback, bug, feature, question
  message        String   // Main feedback text
  wouldRecommend Boolean  // NPS-style question
  isRead         Boolean  // For inbox management
  isStarred      Boolean  // For prioritization
  userId         String   // Form owner
  user           User     @relation(...)
}
```

## SDK Usage Examples

### List Submissions

```typescript
const submissions = await shogo.db.submission.findMany({
  where: { userId },
  orderBy: { createdAt: 'desc' },
})
```

### Create Submission (Public)

```typescript
const submission = await shogo.db.submission.create({
  data: {
    name: 'John Doe',
    email: 'john@example.com',
    rating: 5,
    category: 'feedback',
    message: 'Great product!',
    wouldRecommend: true,
    userId: formOwnerId,
  },
})
```

### Update Submission

```typescript
await shogo.db.submission.update({
  where: { id },
  data: { isRead: true },
})
```

### Aggregations

```typescript
const submissions = await shogo.db.submission.findMany({
  where: { userId },
})

const averageRating = submissions.reduce((sum, s) => sum + s.rating, 0) / submissions.length
const unreadCount = submissions.filter(s => !s.isRead).length
```

## When to Use This Template

✅ **Use this template when:**
- You need a simple feedback/contact form
- The form fields are known and fixed
- You want a quick data collection solution

❌ **Use form-builder template instead when:**
- Users need to create their own forms
- Form fields should be customizable
- You need conditional logic, dynamic validation, etc.

# Pattern 2: Environment Extension

> Inject services into MST stores via environment for dependency injection.

## Concept

MST stores need access to services (email, payments, external APIs, etc.) but shouldn't import them directly. The environment pattern provides:

1. Type-safe service injection at store creation
2. Access to services within MST actions via `getEnv()`
3. Swappable implementations (production vs. test)
4. Clear dependency declaration

> **Note**: Persistence services are auto-injected by the SQL backend system. You only need to extend the environment for custom domain services (external APIs, providers). Basic CRUD operations use the built-in `insertOne()`, `updateOne()`, `deleteOne()`, `query()` methods without manual environment wiring.

---

## When to Apply

Apply this pattern when:

- [ ] Store needs access to a service (from Pattern 1)
- [ ] Different environments need different service implementations
- [ ] Tests need to inject mock services
- [ ] Service is used across multiple actions in the store

Do NOT apply when:

- Service is only used outside of MST (e.g., only in React components)
- There's no need for MST actions to call the service

---

## Structure

### File Organization

```
packages/state-api/src/environment/
└── types.ts        # Base IEnvironment + extensions

packages/state-api/src/{domain}/
├── types.ts        # I{Domain}Service (from Pattern 1)
└── domain.ts       # Store that uses environment
```

### What to Look For in Codebase

When exploring for this pattern, search for:

| Pattern Element | What to Grep/Glob |
|-----------------|-------------------|
| Base environment | `interface IEnvironment` |
| Environment extensions | `extends IEnvironment` |
| Service access | `getEnv<` |
| Store creation with env | `createStore(env)` |

### Component Breakdown

#### 1. Base Environment Interface

```typescript
// environment/types.ts (existing)
export interface IEnvironment {
  services: {
    persistence: IPersistenceService
  }
  context: {
    schemaName: string
    location?: string
  }
}
```

#### 2. Environment Extension

```typescript
// environment/types.ts (extended)
import type { IEmailService } from '../email/types'

export interface IEmailEnvironment extends IEnvironment {
  services: IEnvironment['services'] & {
    email: IEmailService
  }
}
```

#### 3. Accessing Services in MST

```typescript
// Inside enhanceRootStore actions
import { getEnv } from 'mobx-state-tree'
import type { IEmailEnvironment } from '../environment/types'

.actions(self => ({
  async sendNotification(userId: string, message: string) {
    const env = getEnv<IEmailEnvironment>(self)
    const emailService = env.services.email

    await emailService.send({
      to: user.email,
      subject: 'Notification',
      body: message
    })
  }
}))
```

#### 4. Creating Store with Environment

```typescript
// Application bootstrap
const env: IEmailEnvironment = {
  services: {
    persistence,
    email: emailService
  },
  context: {
    schemaName: 'my-app',
    location: './data'
  }
}

const store = createStore(env)
```

---

## Anti-Patterns

### ❌ Direct Service Import in Store

```typescript
// BAD: Not using DI
import { sendGridClient } from '@sendgrid/mail'

.actions(self => ({
  async sendEmail() {
    await sendGridClient.send(...)
  }
}))
```

### ❌ Untyped Environment Access

```typescript
// BAD: Lost type safety
.actions(self => ({
  async sendEmail() {
    const env = getEnv(self) as any
    await env.services.email.send(...)
  }
}))
```

### ❌ Optional Service Without Check

```typescript
// BAD: Could be undefined
const env = getEnv<IEmailEnvironment>(self)
await env.services.email.send(...)  // email might not exist!

// GOOD: Guard check
if (!env.services.email) {
  throw new Error('Email service not configured')
}
```

---

## Checklist

- [ ] Environment extension interface defined
- [ ] Service type imported as `type` only (not runtime)
- [ ] Actions use `getEnv<T>()` with proper generic
- [ ] Optional services have null checks
- [ ] Store creation receives fully-typed environment

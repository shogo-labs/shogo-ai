# Pattern 1: Service Interface

> Abstract external providers behind a domain-focused interface for testability and swappability.

## Concept

When a feature integrates with an external system (payment provider, email service, storage backend), the external API should not leak into domain code. Instead, define an interface that:

1. Uses domain-specific types (not provider types)
2. Has no runtime dependencies on the provider SDK
3. Enables multiple implementations (production, mock, alternative providers)

---

## When to Apply

Apply this pattern when:

- [ ] Feature communicates with an external service
- [ ] Tests need to run without hitting the real service
- [ ] Multiple providers are possible (now or future)
- [ ] Provider SDK has complex types you don't want to propagate

Do NOT apply when:

- Feature is purely local computation
- There's no external dependency
- The "service" is just utility functions

---

## Structure

### File Organization

```
packages/state-api/src/{domain}/
├── types.ts        # Interface + domain types (NO runtime imports)
├── {provider}.ts   # Production implementation
├── mock.ts         # Mock implementation for testing
└── index.ts        # Barrel exports
```

### What to Look For in Codebase

When exploring for this pattern, search for:

| Pattern Element | What to Grep/Glob |
|-----------------|-------------------|
| Existing interfaces | `interface I*Service` |
| Domain types | `export type {Domain}Result` |
| Provider implementations | Class files named after providers |
| Mock implementations | `mock.ts` or `Mock*Service` |

### Component Breakdown

#### 1. Interface Definition (`types.ts`)

**Requirements**:
- Pure TypeScript types only
- NO imports from provider SDKs
- NO runtime code
- Methods return domain types

```typescript
// types.ts - Example structure for an email service

// Domain types (NOT provider types)
export type EmailMessage = {
  to: string
  subject: string
  body: string
  attachments?: Attachment[]
}

export type EmailResult = {
  messageId: string
  status: 'sent' | 'queued' | 'failed'
  error?: EmailError
}

// Service interface
export interface IEmailService {
  send(message: EmailMessage): Promise<EmailResult>
  sendBatch(messages: EmailMessage[]): Promise<EmailResult[]>
  getStatus(messageId: string): Promise<EmailResult>
}
```

#### 2. Production Implementation

```typescript
// sendgrid.ts - Maps provider ↔ domain types

import type { IEmailService, EmailMessage, EmailResult } from './types'
import type { MailService } from '@sendgrid/mail'

export class SendGridEmailService implements IEmailService {
  constructor(private client: MailService) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const sgMessage = this.mapToSendGrid(message)
    const response = await this.client.send(sgMessage)
    return this.mapResult(response)
  }
}
```

#### 3. Mock Implementation

```typescript
// mock.ts - Full implementation with in-memory storage

import type { IEmailService, EmailMessage, EmailResult } from './types'

export class MockEmailService implements IEmailService {
  private sent: Map<string, EmailMessage> = new Map()

  async send(message: EmailMessage): Promise<EmailResult> {
    const messageId = crypto.randomUUID()
    this.sent.set(messageId, message)
    return { messageId, status: 'sent' }
  }

  // Test helpers
  getSentMessages(): EmailMessage[] {
    return Array.from(this.sent.values())
  }
}
```

---

## Anti-Patterns

### ❌ Leaking Provider Types

```typescript
// BAD: Provider types in interface
import { SendGridMessage } from '@sendgrid/mail'
export interface IEmailService {
  send(message: SendGridMessage): Promise<SendGridResponse>
}
```

### ❌ Runtime Imports in Types File

```typescript
// BAD: types.ts has runtime imports
import { createClient } from '@sendgrid/mail'
export interface IEmailService { ... }
```

### ❌ Partial Mock Implementation

```typescript
// BAD: Mock doesn't fully implement interface
export class MockEmailService implements IEmailService {
  send() { return Promise.resolve({ status: 'sent' }) }
  // Missing: sendBatch, getStatus
}
```

---

## Checklist

- [ ] Interface defined with domain types only
- [ ] types.ts has no runtime imports
- [ ] Production implementation maps provider ↔ domain types
- [ ] Mock implementation is complete (not stubs)
- [ ] Error cases handled and mapped to domain errors

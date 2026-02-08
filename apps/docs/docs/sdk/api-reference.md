---
sidebar_position: 5
title: API Reference
slug: /sdk/api-reference
---

# SDK API Reference

Complete reference for all methods available in the Shogo SDK (`@shogo-ai/sdk`).

## Client

### `createClient(options)`

Creates a new Shogo SDK client instance.

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({
  projectId: 'your-project-id',
  // Optional: email provider configuration
  email: { ... },
});
```

**Options:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectId` | `string` | Yes | Your Shogo project ID |
| `email` | `EmailConfig` | No | Email provider configuration |

---

## Authentication (`client.auth`)

### `auth.signUp(options)`

Create a new user account.

```typescript
const user = await client.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
  name: 'User Name',
});
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | `string` | Yes | User's email address |
| `password` | `string` | Yes | User's password |
| `name` | `string` | Yes | User's display name |

**Returns:** `User` object

---

### `auth.signIn(options)`

Sign in with email/password or OAuth provider.

```typescript
// Email/password
await client.auth.signIn({
  email: 'user@example.com',
  password: 'securepassword',
});

// OAuth
await client.auth.signIn({
  provider: 'google', // or 'github'
});
```

**Parameters (email/password):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | `string` | Yes | User's email address |
| `password` | `string` | Yes | User's password |

**Parameters (OAuth):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `'google'` or `'github'` | Yes | OAuth provider |

**Returns:** `Session` object

---

### `auth.signOut()`

End the current session.

```typescript
await client.auth.signOut();
```

---

### `auth.getUser()`

Get the currently signed-in user, or `null` if not authenticated.

```typescript
const user = await client.auth.getUser();
```

**Returns:** `User | null`

---

## Database (`client.db`)

Access collections through `client.db.<collectionName>`.

### `db.<collection>.create(data)`

Create a new record.

```typescript
const record = await client.db.todos.create({
  title: 'New task',
  completed: false,
});
```

**Parameters:** Object with field values

**Returns:** Created record with auto-generated `id`

---

### `db.<collection>.get(id)`

Get a single record by ID.

```typescript
const record = await client.db.todos.get('record-id');
```

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Record ID |

**Returns:** Record object

**Throws:** Error if record not found

---

### `db.<collection>.list(options?)`

List records with optional filtering.

```typescript
const records = await client.db.todos.list({
  where: { completed: false },
});
```

**Parameters (optional):**

| Field | Type | Description |
|-------|------|-------------|
| `where` | `object` | Filter conditions |

**Filter operators:**

| Operator | Description | Example |
|----------|-------------|---------|
| (equals) | Exact match | `{ status: 'active' }` |
| `$gt` | Greater than | `{ price: { $gt: 100 } }` |
| `$gte` | Greater than or equal | `{ age: { $gte: 18 } }` |
| `$lt` | Less than | `{ stock: { $lt: 10 } }` |
| `$lte` | Less than or equal | `{ price: { $lte: 50 } }` |
| `$contains` | Text contains | `{ name: { $contains: 'phone' } }` |

**Returns:** Array of records

---

### `db.<collection>.update(id, data)`

Update an existing record. Only the provided fields are changed.

```typescript
await client.db.todos.update('record-id', {
  completed: true,
});
```

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Record ID |
| `data` | `object` | Fields to update |

**Returns:** Updated record

---

### `db.<collection>.delete(id)`

Delete a record by ID.

```typescript
await client.db.todos.delete('record-id');
```

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Record ID |

---

## Email (`client.email`)

### `email.send(options)`

Send an email.

```typescript
await client.email.send({
  to: 'recipient@example.com',
  subject: 'Hello',
  text: 'Plain text body',
  html: '<p>HTML body</p>',
});
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | `string` or `string[]` | Yes | Recipient(s) |
| `subject` | `string` | Yes | Subject line |
| `text` | `string` | Yes | Plain text body |
| `html` | `string` | No | HTML body |
| `from` | `string` | No | Sender (uses default) |
| `replyTo` | `string` | No | Reply-to address |

---

### `email.sendTemplate(options)`

Send an email using a template with dynamic data.

```typescript
await client.email.sendTemplate({
  to: 'recipient@example.com',
  template: 'welcome',
  data: {
    name: 'Alice',
    loginUrl: 'https://myapp.shogo.one',
  },
});
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | `string` or `string[]` | Yes | Recipient(s) |
| `template` | `string` | Yes | Template name |
| `data` | `object` | Yes | Template variables |
| `from` | `string` | No | Sender (uses default) |

---

## Types

### `User`

```typescript
interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}
```

### `Session`

```typescript
interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}
```

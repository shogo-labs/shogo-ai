---
sidebar_position: 1
title: SDK Introduction
slug: /sdk/introduction
---

# Shogo SDK

The Shogo SDK (`@shogo-ai/sdk`) is a developer toolkit that lets you integrate Shogo-powered features — authentication, database, and email — into your own applications.

:::info For developers
This section is aimed at developers who want to use Shogo's backend services in custom applications. If you're building with the Shogo chat interface, you don't need the SDK — the AI handles everything for you.
:::

## What the SDK provides

- **Authentication** — Email/password signup and login, OAuth (Google, GitHub), session management
- **Database** — Zero-config CRUD operations with MongoDB-style filtering
- **Email** — Send transactional emails via SMTP or AWS SES, with template support
- **Type safety** — Full TypeScript support with generics

## Installation

```bash
npm install @shogo-ai/sdk
```

Or with other package managers:

```bash
yarn add @shogo-ai/sdk
bun add @shogo-ai/sdk
pnpm add @shogo-ai/sdk
```

## Quick example

```typescript
import { createClient } from '@shogo-ai/sdk';

// Initialize the client
const client = createClient({
  projectId: 'your-project-id',
});

// Sign up a new user
await client.auth.signUp({
  email: 'alice@example.com',
  password: 'securepassword',
  name: 'Alice',
});

// Sign in
await client.auth.signIn({
  email: 'alice@example.com',
  password: 'securepassword',
});

// Create a record in the database
await client.db.todos.create({
  title: 'Buy groceries',
  completed: false,
});

// List all todos
const todos = await client.db.todos.list({
  where: { completed: false },
});
```

## Platform support

The SDK works across multiple environments:

| Platform | Support |
|----------|---------|
| Browser (React, Vue, etc.) | Full support |
| Node.js | Full support |
| React Native | Full support |

## SDK sections

- **[Authentication](./authentication)** — User signup, login, OAuth, and sessions
- **[Database](./database)** — CRUD operations, filtering, and querying
- **[Email](./email)** — Send emails with templates
- **[API Reference](./api-reference)** — Complete method reference

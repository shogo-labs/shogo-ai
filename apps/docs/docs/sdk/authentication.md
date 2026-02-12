---
sidebar_position: 2
title: Authentication
slug: /sdk/authentication
---

# SDK Authentication

The Shogo SDK provides built-in authentication so you can add user signup, login, and session management to your app with minimal code.

## Setup

Authentication works out of the box once you initialize the SDK client:

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({
  projectId: 'your-project-id',
});
```

## Email and password

### Sign up

Create a new user account with email, password, and name:

```typescript
const user = await client.auth.signUp({
  email: 'alice@example.com',
  password: 'securepassword123',
  name: 'Alice Johnson',
});

console.log(user); // { id: '...', email: 'alice@example.com', name: 'Alice Johnson' }
```

### Sign in

Log in an existing user:

```typescript
const session = await client.auth.signIn({
  email: 'alice@example.com',
  password: 'securepassword123',
});
```

### Sign out

End the current session:

```typescript
await client.auth.signOut();
```

## OAuth providers

You can also offer social login with Google and GitHub.

### Google OAuth

```typescript
await client.auth.signIn({
  provider: 'google',
});
```

### GitHub OAuth

```typescript
await client.auth.signIn({
  provider: 'github',
});
```

OAuth providers redirect the user to the provider's login page, then back to your app after authentication.

## Session management

### Get current user

Check if a user is currently signed in:

```typescript
const user = await client.auth.getUser();

if (user) {
  console.log(`Signed in as ${user.name}`);
} else {
  console.log('Not signed in');
}
```

### Session persistence

Sessions persist across page reloads and tabs automatically. The SDK handles session tokens and renewal transparently.

## Error handling

Authentication methods throw descriptive errors:

```typescript
try {
  await client.auth.signIn({
    email: 'alice@example.com',
    password: 'wrongpassword',
  });
} catch (error) {
  console.error(error.message); // "Invalid credentials"
}
```

Common errors:

| Error | Cause |
|-------|-------|
| `Invalid credentials` | Wrong email or password |
| `User already exists` | Email is already registered |
| `Invalid email format` | Email address is not valid |
| `Password too short` | Password doesn't meet minimum length |

## Full example

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({ projectId: 'my-app' });

// Registration flow
async function register(email: string, password: string, name: string) {
  try {
    const user = await client.auth.signUp({ email, password, name });
    console.log('Account created:', user.name);
    return user;
  } catch (error) {
    console.error('Registration failed:', error.message);
    throw error;
  }
}

// Login flow
async function login(email: string, password: string) {
  try {
    const session = await client.auth.signIn({ email, password });
    console.log('Logged in successfully');
    return session;
  } catch (error) {
    console.error('Login failed:', error.message);
    throw error;
  }
}

// Check auth state
async function checkAuth() {
  const user = await client.auth.getUser();
  return user !== null;
}
```

# Todo App - Shogo SDK Example (Production-Grade)

A todo application demonstrating production-grade patterns with **@shogo-ai/sdk**:

- **MobX stores** for reactive state management
- **Route protection** via AuthGate component
- **Real authentication** with shogo.auth
- **Optimistic updates** for instant UI feedback
- **Prisma pass-through** for database access

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     App Shell                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │              StoreProvider (MobX)                 │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │              AuthGate                       │  │  │
│  │  │  ┌───────────┐       ┌───────────────────┐ │  │  │
│  │  │  │ LoginPage │  OR   │  Protected Routes │ │  │  │
│  │  │  └───────────┘       └───────────────────┘ │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Key Patterns

### 1. MobX State Management

```typescript
// stores/auth-store.ts
export class AuthStore {
  user: ShogoUser | null = null
  isLoading = true
  isAuthenticated = false

  constructor() {
    makeAutoObservable(this)
  }

  async signIn(email: string, password: string) {
    await shogo.auth.signIn({ email, password })
    // State updated via onAuthStateChanged subscription
  }
}
```

### 2. Route Protection

```typescript
// components/AuthGate.tsx
export const AuthGate = observer(({ children }) => {
  const { auth } = useStores()

  if (auth.isLoading) return <LoadingSpinner />
  if (!auth.isAuthenticated) return <LoginPage />
  return <>{children}</>
})
```

### 3. Optimistic Updates

```typescript
// stores/todo-store.ts
async addTodo(title: string, userId: string) {
  // Optimistically add to UI
  const tempId = crypto.randomUUID()
  this.todos.unshift({ id: tempId, title, completed: false, ... })

  try {
    const todo = await shogo.db.todo.create({ data: { title, userId } })
    // Replace temp with real data
    this.todos[0] = todo
  } catch {
    // Rollback on error
    this.todos = this.todos.filter(t => t.id !== tempId)
  }
}
```

### 4. Real Authentication

```typescript
// Uses shogo.auth for email/password and OAuth
await shogo.auth.signIn({ email, password })
await shogo.auth.signUp({ email, password, name })
await shogo.auth.signInWithGoogle()
await shogo.auth.signOut()
```

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
todo-app/
├── prisma/
│   └── schema.prisma        # User & Todo models
├── src/
│   ├── components/
│   │   ├── AuthGate.tsx     # Route protection
│   │   ├── LoginPage.tsx    # Authentication UI
│   │   └── LoadingSpinner.tsx
│   ├── stores/
│   │   ├── index.ts         # RootStore & StoreProvider
│   │   ├── auth-store.ts    # Authentication state
│   │   └── todo-store.ts    # Todo CRUD with optimistic updates
│   ├── lib/
│   │   ├── db.ts            # Prisma client
│   │   └── shogo.ts         # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx       # Root layout with StoreProvider
│   │   └── index.tsx        # Protected todo app
│   └── utils/
│       ├── user.ts          # (Legacy) User operations
│       └── todos.ts         # (Legacy) Todo operations
├── package.json
└── vite.config.ts
```

## Benefits of This Architecture

| Feature | Benefit |
|---------|---------|
| MobX stores | Reactive UI updates, centralized state |
| AuthGate | Declarative route protection |
| Optimistic updates | Instant UI feedback, better UX |
| shogo.auth | Real authentication flows |
| observer() | Auto re-render on state changes |

## SDK Usage

### Authentication

```typescript
// Sign up
await shogo.auth.signUp({ email, password, name })

// Sign in
await shogo.auth.signIn({ email, password })

// OAuth
await shogo.auth.signInWithGoogle()
await shogo.auth.signInWithGitHub()

// Sign out
await shogo.auth.signOut()

// Listen to auth state changes
shogo.auth.onAuthStateChanged((state) => {
  console.log(state.user, state.isAuthenticated)
})
```

### Database (Prisma Pass-Through)

```typescript
// Create
const todo = await shogo.db.todo.create({
  data: { title, userId }
})

// Read
const todos = await shogo.db.todo.findMany({
  where: { userId },
  orderBy: { createdAt: 'desc' }
})

// Update
await shogo.db.todo.update({
  where: { id },
  data: { completed: true }
})

// Delete
await shogo.db.todo.delete({ where: { id } })
```

## Comparison: Before vs After

| Aspect | Before (Demo) | After (Production) |
|--------|---------------|-------------------|
| Auth | Fake user lookup | Real shogo.auth |
| State | useState + invalidate | MobX stores |
| Routes | All public | Protected via AuthGate |
| Updates | Server roundtrip | Optimistic |
| Reactivity | Manual refresh | Automatic via observer |

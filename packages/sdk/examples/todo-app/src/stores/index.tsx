/**
 * Store Provider and Context
 *
 * Simple store management:
 * - TodoStore for todo CRUD with optimistic updates
 * - React context for store access
 */

import { createContext, useContext, useRef } from 'react'
import { TodoStore } from './todo-store'

/**
 * RootStore - Just the TodoStore for now
 */
export class RootStore {
  todos: TodoStore

  constructor() {
    this.todos = new TodoStore()
  }
}

// Client-side singleton
let clientStore: RootStore | null = null

function getStore(): RootStore {
  if (typeof window === 'undefined') {
    return new RootStore()
  }
  if (!clientStore) {
    clientStore = new RootStore()
  }
  return clientStore
}

const StoreContext = createContext<RootStore | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<RootStore | null>(null)

  if (!storeRef.current) {
    storeRef.current = getStore()
  }

  return (
    <StoreContext.Provider value={storeRef.current}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStores(): RootStore {
  const store = useContext(StoreContext)
  if (!store) {
    throw new Error('useStores must be used within a StoreProvider')
  }
  return store
}

export type { TodoStore, Todo } from './todo-store'

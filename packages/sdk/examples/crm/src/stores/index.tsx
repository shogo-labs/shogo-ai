/**
 * Store Provider and Context
 */

import { createContext, useContext, useRef } from 'react'
import { makeAutoObservable } from 'mobx'
import { AuthStore, getAuthStore } from '../generated/auth'

export { AuthStore, getAuthStore, createAuthStore, resetAuthStore } from '../generated/auth'
export type { AuthUser, SignInInput, SignUpInput } from '../generated/auth'

export class RootStore {
  auth: AuthStore

  constructor() {
    this.auth = getAuthStore()
    makeAutoObservable(this)
  }

  clearAll() {
    this.auth.signOut()
  }
}

let rootStore: RootStore | null = null

function getStore(): RootStore {
  if (!rootStore) {
    rootStore = new RootStore()
  }
  return rootStore
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

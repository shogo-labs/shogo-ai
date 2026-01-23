/**
 * Store Provider and Context
 *
 * Uses the generated domain store from @shogo-ai/sdk
 */

import { createContext, useContext, useRef } from 'react'
import { RootStore, getStore } from '../generated/domain'

// Re-export types
export type { RootStore } from '../generated/domain'
export type { UserType, BoardType, ColumnType, CardType, LabelType } from '../generated/types'

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

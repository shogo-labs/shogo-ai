/**
 * WavesmithStoreContext - Isomorphic React context for MST stores
 *
 * Works in both standard React apps and Sandpack containers.
 * Store creation happens INSIDE the provider (following POC pattern).
 *
 */

import { createContext, useContext, useRef, type ReactNode } from 'react'
import { enhancedJsonSchemaToMST } from '@shogo/state-api'

// Generic store context - works with any MST store
const StoreContext = createContext<any>(null)

export interface WavesmithStoreProviderProps {
  schema: any  // Accept schema, not pre-built store
  children: ReactNode
}

/**
 * Provider component that creates store INSIDE from schema.
 * Uses useRef to ensure store instance stays stable.
 */
export function WavesmithStoreProvider({ schema, children }: WavesmithStoreProviderProps) {
  // Store creation happens INSIDE the provider
  const storeRef = useRef<any>(null)

  if (!storeRef.current) {
    const { createStore } = enhancedJsonSchemaToMST(schema)
    storeRef.current = createStore()
    console.log('[WavesmithStoreProvider] Store created from schema:', schema.name)
  }

  return (
    <StoreContext.Provider value={storeRef.current}>
      {children}
    </StoreContext.Provider>
  )
}

/**
 * Hook to access the store from any component.
 * Must be used within WavesmithStoreProvider.
 */
export function useWavesmithStore<T = any>(): T {
  const store = useContext(StoreContext)
  if (!store) {
    throw new Error('useWavesmithStore must be used within WavesmithStoreProvider')
  }
  return store
}

// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Provider
 *
 * React context provider for domain stores.
 */

import React, { createContext, useContext, useRef, type ReactNode } from 'react'

// ============================================================================
// Types
// ============================================================================

export interface ShogoContextValue<TStore = unknown> {
  /** The root store instance */
  store: TStore
}

// ============================================================================
// Context
// ============================================================================

const ShogoContext = createContext<ShogoContextValue | null>(null)

// ============================================================================
// Provider
// ============================================================================

export interface ShogoProviderProps<TStore> {
  /** Store instance or factory function */
  store: TStore | (() => TStore)
  children: ReactNode
}

/**
 * Provider component for Shogo stores
 *
 * @example
 * ```tsx
 * import { ShogoProvider } from '@shogo-ai/sdk/react'
 * import { getStore } from './generated/domain'
 *
 * function App() {
 *   return (
 *     <ShogoProvider store={getStore}>
 *       <TodoList />
 *     </ShogoProvider>
 *   )
 * }
 * ```
 */
export function ShogoProvider<TStore>({ 
  store: storeOrFactory, 
  children 
}: ShogoProviderProps<TStore>) {
  // Use ref to ensure store is only created once
  const storeRef = useRef<TStore | null>(null)
  
  if (storeRef.current === null) {
    storeRef.current = typeof storeOrFactory === 'function' 
      ? (storeOrFactory as () => TStore)() 
      : storeOrFactory
  }

  const value: ShogoContextValue<TStore> = {
    store: storeRef.current,
  }

  return (
    <ShogoContext.Provider value={value as ShogoContextValue}>
      {children}
    </ShogoContext.Provider>
  )
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access the Shogo context
 *
 * @throws Error if used outside ShogoProvider
 */
export function useShogoContext<TStore>(): ShogoContextValue<TStore> {
  const ctx = useContext(ShogoContext)
  
  if (!ctx) {
    throw new Error('useShogoContext must be used within ShogoProvider')
  }
  
  return ctx as ShogoContextValue<TStore>
}

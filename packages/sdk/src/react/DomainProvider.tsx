/**
 * DomainProvider - SDK React Provider for MST Stores
 *
 * Configurable provider for MST domain stores. Works with generated
 * stores from `shogo generate`.
 *
 * @example
 * ```tsx
 * import { DomainProvider, useDomain } from '@shogo-ai/sdk/react'
 * import { createDomainStore } from './generated/domain'
 *
 * // In App.tsx
 * function App() {
 *   const http = useHttpClient() // Your HttpClient instance
 *
 *   return (
 *     <DomainProvider createStore={() => createDomainStore({ http })}>
 *       <Routes />
 *     </DomainProvider>
 *   )
 * }
 *
 * // In components
 * function WorkspaceList() {
 *   const store = useDomain()
 *   const workspaces = store.workspaceCollection.all
 *   return <div>{workspaces.map(w => w.name)}</div>
 * }
 * ```
 */

import React, {
  createContext,
  useContext,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for DomainProvider
 */
export interface DomainProviderConfig<TStore> {
  /** Factory function to create the domain store */
  createStore: () => TStore
  /** Optional key to force re-creation of store (e.g., on auth change) */
  storeKey?: string | number
  /** Optional callback when store is created */
  onStoreCreated?: (store: TStore) => void
}

/**
 * Context value
 */
interface DomainContextValue<TStore> {
  store: TStore
  isReady: boolean
}

// ============================================================================
// Context
// ============================================================================

const DomainContext = createContext<DomainContextValue<any> | null>(null)

// ============================================================================
// Provider Component
// ============================================================================

export interface DomainProviderProps<TStore> extends DomainProviderConfig<TStore> {
  children: ReactNode
}

/**
 * Provider component for MST domain stores.
 *
 * Creates and provides a domain store to all child components.
 * The store is created once and cached, unless storeKey changes.
 */
export function DomainProvider<TStore>({
  createStore,
  storeKey,
  onStoreCreated,
  children,
}: DomainProviderProps<TStore>) {
  const storeRef = useRef<TStore | null>(null)
  const keyRef = useRef<string | number | undefined>(storeKey)
  const [isReady, setIsReady] = useState(false)

  // Create or recreate store when key changes
  if (storeRef.current === null || keyRef.current !== storeKey) {
    keyRef.current = storeKey
    storeRef.current = createStore()
    
    if (onStoreCreated) {
      onStoreCreated(storeRef.current)
    }
  }

  // Mark as ready on mount
  useEffect(() => {
    setIsReady(true)
  }, [])

  const contextValue: DomainContextValue<TStore> = {
    store: storeRef.current!,
    isReady,
  }

  return (
    <DomainContext.Provider value={contextValue}>
      {children}
    </DomainContext.Provider>
  )
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Hook to access the domain store.
 *
 * @throws Error if used outside DomainProvider
 * @returns The domain store instance
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const store = useDomain()
 *   const workspaces = store.workspaceCollection.all
 *   return <div>{workspaces.length} workspaces</div>
 * }
 * ```
 */
export function useDomain<TStore>(): TStore {
  const ctx = useContext(DomainContext)
  if (!ctx) {
    throw new Error('useDomain must be used within DomainProvider')
  }
  return ctx.store as TStore
}

/**
 * Hook to access a specific collection from the domain store.
 *
 * @param collectionName - Name of the collection (e.g., 'workspaceCollection')
 * @returns The collection instance
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const workspaces = useCollection('workspaceCollection')
 *   return <div>{workspaces.all.length} workspaces</div>
 * }
 * ```
 */
export function useCollection<TCollection>(collectionName: string): TCollection {
  const store = useDomain<any>()
  const collection = store[collectionName]
  if (!collection) {
    throw new Error(`Collection "${collectionName}" not found in domain store`)
  }
  return collection as TCollection
}

/**
 * Hook to check if the domain store is ready.
 *
 * @returns Object with isReady boolean
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isReady } = useDomainReady()
 *   if (!isReady) return <LoadingSpinner />
 *   return <Content />
 * }
 * ```
 */
export function useDomainReady(): { isReady: boolean } {
  const ctx = useContext(DomainContext)
  if (!ctx) {
    throw new Error('useDomainReady must be used within DomainProvider')
  }
  return { isReady: ctx.isReady }
}

// ============================================================================
// Higher-Order Component
// ============================================================================

/**
 * HOC to inject the domain store as a prop.
 *
 * @param Component - Component to wrap
 * @returns Wrapped component with store prop
 *
 * @example
 * ```tsx
 * interface Props {
 *   store: IDomainStore
 * }
 *
 * function MyComponent({ store }: Props) {
 *   return <div>{store.workspaceCollection.all.length}</div>
 * }
 *
 * export default withDomain(MyComponent)
 * ```
 */
export function withDomain<TStore, P extends { store: TStore }>(
  Component: React.ComponentType<P>
): React.FC<Omit<P, 'store'>> {
  return function WithDomainWrapper(props: Omit<P, 'store'>) {
    const store = useDomain<TStore>()
    return <Component {...(props as any)} store={store} />
  }
}

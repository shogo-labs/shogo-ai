/**
 * ShogoMetaStoreContext - React context for isomorphic meta-store
 *
 * Provides a meta-store with MCPPersistence for dynamic schema loading.
 * Use this when you need to load schemas at runtime via MCP rather than
 * static imports.
 *
 * Usage:
 * ```tsx
 * <ShogoMetaStoreProvider>
 *   <MyApp />
 * </ShogoMetaStoreProvider>
 *
 * function MyApp() {
 *   const metaStore = useShogoMetaStore()
 *   const [schema, setSchema] = useState(null)
 *
 *   useEffect(() => {
 *     metaStore.loadSchema('my-schema').then(setSchema)
 *   }, [])
 *
 *   if (!schema) return <div>Loading...</div>
 *
 *   // schema.runtimeStore has persistence already composed
 *   const store = schema.runtimeStore
 * }
 * ```
 */

import { createContext, useContext, useRef, type ReactNode } from 'react'
import { type IPersistenceService, createMetaStoreInstance } from '@shogo/state-api'
import { useOptionalEnv } from './EnvironmentContext'

interface MetaStoreContextValue {
  metaStore: any
  persistence: IPersistenceService
}

const MetaStoreContext = createContext<MetaStoreContextValue | null>(null)

export interface ShogoMetaStoreProviderProps {
  /** Optional custom persistence service. Defaults to MCPPersistence. */
  persistence?: IPersistenceService
  children: ReactNode
}

/**
 * Provider that creates a meta-store with persistence support.
 *
 * Gets persistence from EnvironmentProvider ancestor by default.
 * The meta-store provides `loadSchema()` action for dynamic schema loading.
 */
export function ShogoMetaStoreProvider({
  persistence: customPersistence,
  children
}: ShogoMetaStoreProviderProps) {
  // Get persistence from EnvironmentProvider if available
  const ancestorEnv = useOptionalEnv()
  const contextRef = useRef<MetaStoreContextValue | null>(null)

  if (!contextRef.current) {
    // Use custom persistence prop, or fall back to EnvironmentProvider's persistence
    const persistence = customPersistence ?? ancestorEnv?.services.persistence

    if (!persistence) {
      throw new Error(
        'ShogoMetaStoreProvider requires persistence. ' +
        'Either provide a persistence prop or wrap in EnvironmentProvider.'
      )
    }

    // Create meta-store with persistence injected
    const metaStore = createMetaStoreInstance({ services: { persistence } })

    contextRef.current = { metaStore, persistence }
    console.log('[ShogoMetaStoreProvider] Meta-store created with persistence')
  }

  return (
    <MetaStoreContext.Provider value={contextRef.current}>
      {children}
    </MetaStoreContext.Provider>
  )
}

/**
 * Hook to access the meta-store.
 *
 * The meta-store provides:
 * - `loadSchema(name, workspace?)` - Load schema by name, returns Schema entity
 * - `findSchemaByName(name)` - Find already-loaded schema
 * - Schema entities with `runtimeStore` accessor
 *
 * @returns The meta-store instance
 * @throws Error if used outside ShogoMetaStoreProvider
 */
export function useShogoMetaStore() {
  const context = useContext(MetaStoreContext)
  if (!context) {
    throw new Error('useShogoMetaStore must be used within ShogoMetaStoreProvider')
  }
  return context.metaStore
}

/**
 * Hook to optionally access the meta-store.
 *
 * Returns null if used outside ShogoMetaStoreProvider, allowing
 * components to gracefully handle missing meta-store context.
 *
 * @returns The meta-store instance or null
 */
export function useOptionalShogoMetaStore() {
  const context = useContext(MetaStoreContext)
  return context?.metaStore ?? null
}

/**
 * Hook to access the persistence service directly.
 *
 * Useful for direct data operations without going through the meta-store.
 *
 * @returns The persistence service (MCPPersistence by default)
 */
export function useShogoPersistence() {
  const context = useContext(MetaStoreContext)
  if (!context) {
    throw new Error('useShogoPersistence must be used within ShogoMetaStoreProvider')
  }
  return context.persistence
}

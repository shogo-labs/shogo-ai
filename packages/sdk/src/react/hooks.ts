/**
 * Shogo React Hooks
 *
 * Hooks for accessing and observing stores.
 */

import { useSyncExternalStore, useCallback } from 'react'
import { useShogoContext } from './provider'

/**
 * Hook to access the root store
 *
 * @example
 * ```tsx
 * import { useStore } from '@shogo-ai/sdk/react'
 * import { observer } from 'mobx-react-lite'
 *
 * const TodoList = observer(() => {
 *   const store = useStore()
 *   const todos = store.todo.all
 *
 *   return (
 *     <ul>
 *       {todos.map(t => <li key={t.id}>{t.title}</li>)}
 *     </ul>
 *   )
 * })
 * ```
 */
export function useStore<TStore>(): TStore {
  const { store } = useShogoContext<TStore>()
  return store
}

/**
 * Hook to select a specific piece of state from the store
 *
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 * For MobX stores, prefer using `observer()` HOC instead.
 *
 * @example
 * ```tsx
 * import { useStoreSelector } from '@shogo-ai/sdk/react'
 *
 * function TodoCount() {
 *   const count = useStoreSelector(
 *     store => store.todo.all.length,
 *     store => {
 *       // Subscribe to changes
 *       const dispose = autorun(() => store.todo.all.length)
 *       return dispose
 *     }
 *   )
 *
 *   return <span>{count} todos</span>
 * }
 * ```
 */
export function useStoreSelector<TStore, TSelected>(
  selector: (store: TStore) => TSelected,
  subscribe: (store: TStore, callback: () => void) => () => void
): TSelected {
  const { store } = useShogoContext<TStore>()

  const subscribeWithStore = useCallback(
    (callback: () => void) => subscribe(store, callback),
    [store, subscribe]
  )

  const getSnapshot = useCallback(
    () => selector(store),
    [store, selector]
  )

  return useSyncExternalStore(subscribeWithStore, getSnapshot, getSnapshot)
}

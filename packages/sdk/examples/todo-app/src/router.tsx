/**
 * Router Configuration
 *
 * Production-grade setup:
 * - No server-side auth context (handled by MobX AuthStore)
 * - Scroll restoration enabled
 * - Preloading on intent for better UX
 */

import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  })
  return router
}

// TanStack Start requires this export
export function getRouter() {
  return createRouter()
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}

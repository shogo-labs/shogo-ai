import { useRef, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { AuthGate, AppShell, SchemaLoadingGate } from '@/components/app'
import { WorkspaceLayout } from '@/components/app/workspace'
import { AdvancedChatLayout } from './components/app/advanced-chat'
import { ProjectLayout } from './components/app/project'
import { AppProfilePage } from './pages/AppProfilePage'
import { AppBillingPage } from './pages/AppBillingPage'
import { AppMemberManagementPage } from './pages/AppMemberManagementPage'
import { AllProjectsPage } from './pages/AllProjectsPage'
import { StarredProjectsPage } from './pages/StarredProjectsPage'
import { SharedWithMePage } from './pages/SharedWithMePage'
import { TemplatesPage } from './pages/TemplatesPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthProvider } from './contexts/AuthContext'
import { EnvironmentProvider, createEnvironment } from './contexts/EnvironmentContext'
import { DomainProvider, type EagerCollectionsConfig } from './contexts/DomainProvider'
import { WavesmithMetaStoreProvider } from './contexts/WavesmithMetaStoreContext'
import { SessionProvider, useSessionContext } from './contexts/SessionProvider'
import { SupabaseAuthService, createBackendRegistry, teamsDomain, teamsMultiTenancyDomain, chatDomain, studioCoreDomain, studioChatDomain, platformFeaturesDomain, betterAuthDomain, componentBuilderDomain, billingDomain, BetterAuthService, AuthorizationService, MemoryBackend } from '@shogo/state-api'
import { APIPersistence } from './persistence/APIPersistence'
import { Toaster } from '@/components/ui/toaster'

// BetterAuth configuration
// Uses VITE_BETTER_AUTH_URL or falls back to current origin for same-origin API
const betterAuthUrl = import.meta.env.VITE_BETTER_AUTH_URL || ''
const betterAuthService = new BetterAuthService({ baseUrl: betterAuthUrl })

// Create backend registry with memory backend (data loaded via APIPersistence, queries run in-memory)
const backendRegistry = createBackendRegistry({
  default: 'memory',
  backends: { memory: new MemoryBackend() }
})

// Create API persistence (userId set dynamically when user authenticates)
const apiPersistence = new APIPersistence()

// Centralized environment configuration
// Note: auth service is used by betterAuthDomain for authentication
const env = createEnvironment({
  persistence: apiPersistence,
  backendRegistry,
  auth: betterAuthService,
  authorization: new AuthorizationService(),
  workspace: import.meta.env.VITE_WORKSPACE,
})

// Domain configuration - keys become property names in useDomains()
// Access via: const { teams, auth, chat, componentBuilder, ... } = useDomains()
const domains = {
  teams: teamsDomain,
  multiTenancy: teamsMultiTenancyDomain,
  chat: chatDomain,
  studioCore: studioCoreDomain,
  studioChat: studioChatDomain,
  platformFeatures: platformFeaturesDomain,
  auth: betterAuthDomain,
  componentBuilder: componentBuilderDomain,
  billing: billingDomain,
} as const

/**
 * OPTIMIZATION: Only load essential collections on startup.
 * This reduces initial MCP calls from ~130 to ~20.
 *
 * Essential collections for initial render:
 * - studioCore: workspace/member/project/folder (sidebar, workspace switcher)
 * - componentBuilder: rendererBinding (component registry)
 * - billing: subscription (upgrade CTA)
 * - platformFeatures: featureSession (feature list if project selected)
 *
 * Deferred collections (empty array = don't load on mount):
 * - teams, multiTenancy, chat, studioChat, auth (not used on landing page)
 * - studioCore: starredProject, invitation (load on demand)
 */
const eagerCollections: EagerCollectionsConfig = {
  // Essential for initial render
  studioCore: [
    'workspaceCollection',
    'memberCollection',
    'projectCollection',
    'folderCollection',
    // Deferred: starredProjectCollection, invitationCollection
  ],
  // compositionCollection and layoutTemplateCollection are needed for ComposablePhaseView
  // to render workspace layouts (e.g., when AI calls set_workspace)
  componentBuilder: ['rendererBindingCollection', 'compositionCollection', 'layoutTemplateCollection'],
  billing: ['subscriptionCollection', 'creditLedgerCollection'],
  platformFeatures: ['featureSessionCollection'],

  // Deferred - don't load on mount (empty array)
  // These collections are loaded on-demand when the user navigates to relevant views
  teams: [],
  multiTenancy: [],
  chat: [],
  // studioChat: Lazy load chat data only when entering a project/chat view
  // This avoids loading potentially large chat history on every page load
  studioChat: [],
  auth: [],
}

/**
 * Inner app component that uses session context.
 * Separated to ensure SessionProvider is available.
 */
function AppWithSession() {
  // Use centralized session context (single source of truth)
  const session = useSessionContext()

  // Use a ref to stabilize the key during transient loading states.
  // This prevents DomainProvider from remounting when Better Auth refetches
  // the session (e.g., on tab focus), which would cause an unwanted logout.
  //
  // IMPORTANT: We ONLY update the ref when we see a valid user ID.
  // We NEVER clear the ref based on session becoming null - that could be
  // a transient state during refetch. The ref only resets on page refresh.
  // If the user actually logs out, AuthGate handles showing the login page
  // without needing to remount DomainProvider.
  const lastKnownUserIdRef = useRef<string | null>(null)

  const currentUserId = session.userId
  if (currentUserId) {
    lastKnownUserIdRef.current = currentUserId
  }

  // Update APIPersistence with current user ID for user-scoped queries
  useEffect(() => {
    apiPersistence.setUserId(currentUserId ?? null)
  }, [currentUserId])

  // Use the stable ref value, or 'anonymous' only if we've never seen a user
  const authKey = lastKnownUserIdRef.current ?? 'anonymous'

  return (
    <EnvironmentProvider env={env}>
      <DomainProvider key={authKey} domains={domains} eagerCollections={eagerCollections}>
        <SchemaLoadingGate>
          <WavesmithMetaStoreProvider>
            <AuthProvider authService={betterAuthService}>
              <Routes>
                  {/* Project view route - full screen without sidebar */}
                  <Route path="/projects/:projectId" element={
                    <AuthGate>
                      <ProjectLayout />
                    </AuthGate>
                  } />

                  {/* Settings page - standalone without AppShell sidebar */}
                  <Route path="/settings" element={
                    <AuthGate>
                      <SettingsPage />
                    </AuthGate>
                  } />

                  {/* Project settings - with project context */}
                  <Route path="/projects/:projectId/settings" element={
                    <AuthGate>
                      <SettingsPage />
                    </AuthGate>
                  } />

                  {/* Protected root route - Shogo Studio App */}
                  <Route path="/*" element={
                    <AuthGate>
                      <AppShell />
                    </AuthGate>
                  }>
                    {/* WorkspaceLayout as index route */}
                    <Route index element={<WorkspaceLayout />} />
                    {/* Advanced Chat testbed route (task-testbed-route) */}
                    <Route path="advanced-chat" element={<AdvancedChatLayout />} />
                    {/* Profile page */}
                    <Route path="profile" element={<AppProfilePage />} />
                    {/* Billing management */}
                    <Route path="billing" element={<AppBillingPage />} />
                    {/* Member management */}
                    <Route path="members" element={<AppMemberManagementPage />} />
                    {/* All projects page */}
                    <Route path="projects" element={<AllProjectsPage />} />
                    {/* Starred projects */}
                    <Route path="starred" element={<StarredProjectsPage />} />
                    {/* Shared projects */}
                    <Route path="shared" element={<SharedWithMePage />} />
                    {/* Discover */}
                    <Route path="discover" element={<AllProjectsPage />} />
                    {/* Templates */}
                    <Route path="templates" element={<TemplatesPage />} />
                  </Route>
                </Routes>
            </AuthProvider>
          </WavesmithMetaStoreProvider>
        </SchemaLoadingGate>
      </DomainProvider>
    </EnvironmentProvider>
  )
}

/**
 * Root App component with providers.
 * SessionProvider is at the top to enable centralized session management.
 */
function App() {
  return (
    <NuqsAdapter>
      <BrowserRouter>
        <SessionProvider>
          <AppWithSession />
        </SessionProvider>
        <Toaster />
      </BrowserRouter>
    </NuqsAdapter>
  )
}

export default App

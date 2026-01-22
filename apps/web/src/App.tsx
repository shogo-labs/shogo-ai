import { useRef } from 'react'
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
import { MCPBackend } from './query/MCPBackend'
import { SupabaseAuthService, MockAuthService, createBackendRegistry, teamsDomain, teamsMultiTenancyDomain, chatDomain, studioCoreDomain, studioChatDomain, platformFeaturesDomain, betterAuthDomain, componentBuilderDomain, billingDomain, BetterAuthService, AuthorizationService } from '@shogo/state-api'
import { MCPPersistence } from './persistence/MCPPersistence'
import { mcpService } from './services/mcpService'
import { Toaster } from '@/components/ui/toaster'
import { useSession } from './auth/client'

// Initialize auth service with mock for development
const authService = new MockAuthService()

// BetterAuth configuration
// Uses VITE_BETTER_AUTH_URL or falls back to current origin for same-origin API
const betterAuthUrl = import.meta.env.VITE_BETTER_AUTH_URL || ''
const betterAuthService = new BetterAuthService({ baseUrl: betterAuthUrl })

// Create MCP-backed backend registry
// Register as 'postgres' so schemas with x-persistence.backend: 'postgres' work
const mcpBackend = new MCPBackend(mcpService, import.meta.env.VITE_WORKSPACE)
const backendRegistry = createBackendRegistry({
  default: 'postgres',
  backends: { postgres: mcpBackend }
})

// Centralized environment configuration
// Note: auth service is used by betterAuthDomain for authentication
const env = createEnvironment({
  persistence: new MCPPersistence(mcpService),
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
  billing: ['subscriptionCollection'],
  platformFeatures: ['featureSessionCollection'],

  // Deferred - don't load on mount (empty array)
  teams: [],
  multiTenancy: [],
  chat: [],
  // studioChat needs to load sessions for chat persistence to work
  studioChat: ['chatSessionCollection', 'chatMessageCollection'],
  auth: [],
}

function App() {
  // Track current user ID to force DomainProvider remount on user change
  // This ensures stores are recreated with fresh data when switching users
  const session = useSession()

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

  const currentUserId = session.data?.user?.id
  if (currentUserId) {
    lastKnownUserIdRef.current = currentUserId
  }

  // Use the stable ref value, or 'anonymous' only if we've never seen a user
  const authKey = lastKnownUserIdRef.current ?? 'anonymous'

  return (
    <NuqsAdapter>
      <BrowserRouter>
        <EnvironmentProvider env={env}>
          <DomainProvider key={authKey} domains={domains} eagerCollections={eagerCollections}>
            <SchemaLoadingGate>
              <WavesmithMetaStoreProvider>
                <AuthProvider authService={authService}>
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
        <Toaster />
      </BrowserRouter>
    </NuqsAdapter>
  )
}

export default App

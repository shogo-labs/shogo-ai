import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7'
import { AuthGate, AppShell } from '@/components/app'
import { WorkspaceLayout } from '@/components/app/workspace'
import { AdvancedChatLayout } from './components/app/advanced-chat'
import { AppProfilePage } from './pages/AppProfilePage'
import { AppBillingPage } from './pages/AppBillingPage'
import { AppMemberManagementPage } from './pages/AppMemberManagementPage'
import { AllProjectsPage } from './pages/AllProjectsPage'
import { AuthProvider } from './contexts/AuthContext'
import { EnvironmentProvider, createEnvironment } from './contexts/EnvironmentContext'
import { DomainProvider } from './contexts/DomainProvider'
import { WavesmithMetaStoreProvider } from './contexts/WavesmithMetaStoreContext'
import { MCPBackend } from './query/MCPBackend'
import { SupabaseAuthService, MockAuthService, createBackendRegistry, teamsDomain, teamsMultiTenancyDomain, chatDomain, studioCoreDomain, studioChatDomain, platformFeaturesDomain, betterAuthDomain, componentBuilderDomain, billingDomain, BetterAuthService } from '@shogo/state-api'
import { MCPPersistence } from './persistence/MCPPersistence'
import { mcpService } from './services/mcpService'
import { Toaster } from '@/components/ui/toaster'

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

function App() {
  return (
    <NuqsAdapter>
      <BrowserRouter>
        <EnvironmentProvider env={env}>
          <DomainProvider domains={domains}>
            <WavesmithMetaStoreProvider>
              <AuthProvider authService={authService}>
                <Routes>
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
                    <Route path="starred" element={<AllProjectsPage />} />
                    {/* Shared projects */}
                    <Route path="shared" element={<AllProjectsPage />} />
                    {/* Discover */}
                    <Route path="discover" element={<AllProjectsPage />} />
                    {/* Templates */}
                    <Route path="templates" element={<AllProjectsPage />} />
                  </Route>
                </Routes>
              </AuthProvider>
            </WavesmithMetaStoreProvider>
          </DomainProvider>
        </EnvironmentProvider>
        <Toaster />
      </BrowserRouter>
    </NuqsAdapter>
  )
}

export default App

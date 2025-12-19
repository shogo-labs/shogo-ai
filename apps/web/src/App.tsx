import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { createClient } from '@supabase/supabase-js'
import { HomePage } from './pages/HomePage'
import { Unit1Page } from './pages/Unit1Page'
import { Unit2Page } from './pages/Unit2Page'
import { Unit3Page } from './pages/Unit3Page'
import { LegacyTestsPage } from './pages/LegacyTestsPage'
import { AuthDemoPage } from './pages/AuthDemoPage'
import { TeamsDemoPage } from './pages/TeamsDemoPage'
import { TenantDemoPage } from './pages/TenantDemoPage'
import { PlatformFeaturesPage } from './pages/PlatformFeaturesPage'
import { AIChatDemoPage } from './pages/AIChatDemoPage'
import { FeatureControlPlanePage } from './pages/FeatureControlPlanePage'
import { AuthProvider } from './contexts/AuthContext'
import { EnvironmentProvider, createEnvironment } from './contexts/EnvironmentContext'
import { DomainProvider } from './contexts/DomainProvider'
import { WavesmithMetaStoreProvider } from './contexts/WavesmithMetaStoreContext'
import { MCPBackend } from './query/MCPBackend'
import { SupabaseAuthService, MockAuthService, createBackendRegistry, teamsDomain, teamsMultiTenancyDomain, chatDomain } from '@shogo/state-api'
import { MCPPersistence } from './persistence/MCPPersistence'
import { mcpService } from './services/mcpService'
import { cn } from '@/lib/utils'

// Initialize auth service - use Supabase if configured, otherwise mock
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const authService = supabaseUrl && supabaseKey
  ? new SupabaseAuthService(createClient(supabaseUrl, supabaseKey))
  : new MockAuthService()

// Create MCP-backed backend registry
// Register as 'postgres' so schemas with x-persistence.backend: 'postgres' work
const mcpBackend = new MCPBackend(mcpService, import.meta.env.VITE_WORKSPACE)
const backendRegistry = createBackendRegistry({
  default: 'postgres',
  backends: { postgres: mcpBackend }
})

// Centralized environment configuration
const env = createEnvironment({
  persistence: new MCPPersistence(mcpService),
  backendRegistry,
  workspace: import.meta.env.VITE_WORKSPACE,
})

// Domain configuration - keys become property names in useDomains()
const domains = {
  teams: teamsDomain,
  multiTenancy: teamsMultiTenancyDomain,
  chat: chatDomain,
} as const

function Navigation() {
  const location = useLocation()

  return (
    <nav className="px-8 py-4 bg-card border-b-2 border-border flex gap-3 items-center flex-wrap">
      <NavLink to="/" current={location.pathname}>Home</NavLink>
      <NavLink to="/unit1" current={location.pathname}>Unit 1: Host MST</NavLink>
      <NavLink to="/unit2" current={location.pathname}>Unit 2: Meta-System</NavLink>
      <NavLink to="/unit3" current={location.pathname}>Unit 3: App Builder</NavLink>
      <NavLink to="/legacy-tests" current={location.pathname}>Legacy Tests</NavLink>
      <NavLink to="/auth-demo" current={location.pathname}>Auth Demo</NavLink>
      <NavLink to="/teams-demo" current={location.pathname}>Teams Demo</NavLink>
      <NavLink to="/tenant-demo" current={location.pathname}>Tenant Demo</NavLink>
      <NavLink to="/feature-control-plane" current={location.pathname}>Feature Control Plane</NavLink>
      <NavLink to="/platform-features" current={location.pathname}>Platform Features</NavLink>
      <NavLink to="/ai-chat-demo" current={location.pathname}>AI Chat Demo</NavLink>
    </nav>
  )
}

function NavLink({ to, current, children }: { to: string; current: string; children: React.ReactNode }) {
  const isActive = current === to
  return (
    <Link
      to={to}
      className={cn(
        "px-4 py-2 rounded-md text-sm font-bold transition-colors no-underline",
        isActive
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
      )}
    >
      {children}
    </Link>
  )
}

function App() {
  return (
    <BrowserRouter>
      <EnvironmentProvider env={env}>
        <DomainProvider domains={domains}>
          <WavesmithMetaStoreProvider>
            <AuthProvider authService={authService}>
              <Navigation />
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/unit1" element={<Unit1Page />} />
                <Route path="/unit2" element={<Unit2Page />} />
                <Route path="/unit3" element={<Unit3Page />} />
                <Route path="/legacy-tests" element={<LegacyTestsPage />} />
                <Route path="/auth-demo" element={<AuthDemoPage />} />
                <Route path="/teams-demo" element={<TeamsDemoPage />} />
                <Route path="/tenant-demo" element={<TenantDemoPage />} />
                <Route path="/feature-control-plane" element={<FeatureControlPlanePage />} />
                <Route path="/platform-features" element={<PlatformFeaturesPage />} />
                <Route path="/ai-chat-demo" element={<AIChatDemoPage />} />
              </Routes>
            </AuthProvider>
          </WavesmithMetaStoreProvider>
        </DomainProvider>
      </EnvironmentProvider>
    </BrowserRouter>
  )
}

export default App

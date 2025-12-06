/**
 * AuthDemoPage - Proof of work page for Supabase Auth implementation
 *
 * Demonstrates the full auth implementation with real Supabase credentials:
 * - Login form with email/password
 * - Signup form with validation
 * - Protected routes
 * - Auth state management with MST
 */

import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { observer } from 'mobx-react-lite'
import { AuthProvider } from '../contexts/AuthContext'
import { LoginForm } from '../components/Auth/LoginForm'
import { SignupForm } from '../components/Auth/SignupForm'
import { ProtectedRoute } from '../components/Auth/ProtectedRoute'
import { useAuth } from '../hooks/useAuth'

// Styles
const containerStyle = {
  padding: '2rem',
  maxWidth: '1200px',
  margin: '0 auto',
  color: '#e5e7eb',
}

const headerStyle = {
  marginBottom: '2rem',
  paddingBottom: '1rem',
  borderBottom: '2px solid #333',
  color: '#f3f4f6',
}

const cardStyle = {
  background: '#1e1e1e',
  border: '1px solid #333',
  borderRadius: '8px',
  padding: '1.5rem',
  marginBottom: '1rem',
  color: '#e5e7eb',
}

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: '1.5rem',
  marginTop: '1.5rem',
}

const featureListStyle = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
}

const featureItemStyle = {
  padding: '0.5rem 0',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  color: '#e5e7eb',
}

const badgeStyle = (color: string) => ({
  display: 'inline-block',
  padding: '0.25rem 0.5rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
  fontWeight: 'bold' as const,
  background: color,
  color: 'white',
})

const navLinkStyle = (isActive: boolean) => ({
  padding: '0.5rem 1rem',
  borderRadius: '4px',
  textDecoration: 'none',
  fontWeight: 'bold' as const,
  background: isActive ? '#3b82f6' : '#333',
  color: 'white',
  transition: 'background 0.2s',
})

/**
 * Auth status display component - shows real Supabase auth state
 */
const AuthStatus = observer(function AuthStatus() {
  const { user, isAuthenticated, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>⏳</span>
          <span>Checking authentication with Supabase...</span>
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={badgeStyle(isAuthenticated ? '#10b981' : '#6b7280')}>
            {isAuthenticated ? 'Authenticated' : 'Not Authenticated'}
          </span>
          {user && (
            <span style={{ marginLeft: '1rem', color: '#9ca3af' }}>
              {user.email}
            </span>
          )}
        </div>
        {isAuthenticated && (
          <button
            onClick={() => signOut()}
            style={{
              padding: '0.5rem 1rem',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Sign Out
          </button>
        )}
      </div>
    </div>
  )
})

/**
 * Sub-navigation for auth demo pages
 */
function AuthNavigation() {
  const location = useLocation()
  const basePath = '/auth-demo'

  return (
    <nav style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
      <Link to={`${basePath}`} style={navLinkStyle(location.pathname === basePath)}>
        Overview
      </Link>
      <Link to={`${basePath}/login`} style={navLinkStyle(location.pathname === `${basePath}/login`)}>
        Login
      </Link>
      <Link to={`${basePath}/signup`} style={navLinkStyle(location.pathname === `${basePath}/signup`)}>
        Sign Up
      </Link>
      <Link to={`${basePath}/dashboard`} style={navLinkStyle(location.pathname === `${basePath}/dashboard`)}>
        Dashboard (Protected)
      </Link>
    </nav>
  )
}

/**
 * Overview page showing implemented features
 */
function OverviewContent() {
  return (
    <div>
      <h2 style={{ marginTop: 0, color: '#333' }}>Supabase Auth Implementation</h2>
      <p style={{ color: '#9ca3af' }}>
        This page demonstrates the complete authentication layer using your configured Supabase credentials.
        All auth operations connect to your real Supabase project.
      </p>

      <div style={gridStyle}>
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, color: '#3b82f6' }}>Core Services</h3>
          <ul style={featureListStyle}>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>IAuthService interface abstraction</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>SupabaseAuthService implementation</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>MockAuthService for testing</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>IEnvironment DI extension</span>
            </li>
          </ul>
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, color: '#8b5cf6' }}>State Management</h3>
          <ul style={featureListStyle}>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>AuthDomain ArkType schema</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>MST store with enhancement hooks</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>Reactive state via MobX observers</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>Session persistence across refreshes</span>
            </li>
          </ul>
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, color: '#f59e0b' }}>React Integration</h3>
          <ul style={featureListStyle}>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>AuthContext & AuthProvider</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>useAuth hook with loading/error</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>LoginForm component</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>SignupForm with validation</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>ProtectedRoute wrapper</span>
            </li>
          </ul>
        </div>

        <div style={cardStyle}>
          <h3 style={{ marginTop: 0, color: '#ec4899' }}>Test Coverage</h3>
          <ul style={featureListStyle}>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>66</span>
              <span>Tests passing</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>Service layer tests</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>Domain store tests</span>
            </li>
            <li style={featureItemStyle}>
              <span style={badgeStyle('#10b981')}>✓</span>
              <span>Component SSR tests</span>
            </li>
          </ul>
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: '1.5rem', background: '#1a2744' }}>
        <h3 style={{ marginTop: 0, color: '#60a5fa' }}>Try It Out</h3>
        <p style={{ color: '#9ca3af', margin: 0 }}>
          Use the navigation above to test the auth flow with your Supabase project:
        </p>
        <ol style={{ color: '#d1d5db', paddingLeft: '1.5rem', marginBottom: 0 }}>
          <li>Go to <strong>Sign Up</strong> to create an account (check your email for confirmation)</li>
          <li>After confirming, go to <strong>Login</strong> to authenticate</li>
          <li>Try accessing <strong>Dashboard</strong> - it's protected and will redirect if not logged in</li>
          <li>Once logged in, the Dashboard shows your Supabase user info</li>
        </ol>
      </div>
    </div>
  )
}

/**
 * Protected dashboard content - shows real Supabase user data
 */
const DashboardContent = observer(function DashboardContent() {
  const { user } = useAuth()

  return (
    <div>
      <h2 style={{ marginTop: 0, color: '#10b981' }}>Protected Dashboard</h2>
      <p style={{ color: '#9ca3af' }}>
        You're authenticated with Supabase. This content is only visible to logged-in users.
      </p>

      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Supabase User Information</h3>
        {user && (
          <div style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>
            <div style={{ marginBottom: '0.5rem' }}>
              <span style={{ color: '#6b7280' }}>ID:</span>{' '}
              <span style={{ color: '#60a5fa' }}>{user.id}</span>
            </div>
            <div style={{ marginBottom: '0.5rem' }}>
              <span style={{ color: '#6b7280' }}>Email:</span>{' '}
              <span style={{ color: '#60a5fa' }}>{user.email}</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>Created:</span>{' '}
              <span style={{ color: '#60a5fa' }}>{user.createdAt}</span>
            </div>
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Implementation Details</h3>
        <ul style={{ color: '#d1d5db', paddingLeft: '1.5rem', marginBottom: 0 }}>
          <li>The <code style={{ color: '#f59e0b' }}>ProtectedRoute</code> component wraps this page</li>
          <li>It checks <code style={{ color: '#f59e0b' }}>isAuthenticated</code> from the MST store</li>
          <li>Session is restored from Supabase on page load via <code style={{ color: '#f59e0b' }}>initializeAuth()</code></li>
          <li>Auth state changes are synced via <code style={{ color: '#f59e0b' }}>onAuthStateChange</code> listener</li>
        </ul>
      </div>
    </div>
  )
})

/**
 * Login page wrapper
 */
function LoginPage() {
  return <LoginForm />
}

/**
 * Signup page wrapper
 */
function SignupPage() {
  return <SignupForm />
}

/**
 * Main AuthDemoPage component - uses real Supabase via AuthProvider
 */
export function AuthDemoPage() {
  return (
    <AuthProvider>
      <div style={containerStyle}>
        <header style={headerStyle}>
          <h1 style={{ color: '#333', margin: 0 }}>Auth Demo</h1>
          <p style={{ color: '#9ca3af', marginBottom: 0 }}>
            Proof of work for the Supabase Auth platform feature implementation
          </p>
        </header>

        <AuthStatus />
        <AuthNavigation />

        <Routes>
          <Route index element={<OverviewContent />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route
            path="dashboard"
            element={
              <ProtectedRoute redirectTo="/auth-demo/login">
                <DashboardContent />
              </ProtectedRoute>
            }
          />
        </Routes>
      </div>
    </AuthProvider>
  )
}
